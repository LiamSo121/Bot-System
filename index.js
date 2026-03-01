/**
 * WhatsApp Multi-Tenant SaaS Engine
 * המנוע המרכזי הגנרי - אין כאן שום לוגיקה ספציפית לבוט מסוים.
 * כל ההתאמות נמצאות ב: tools/, logicFactory.js, bots.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { VertexAI } = require('@google-cloud/vertexai');
const dotenv = require('dotenv');

const logicFactory = require('./logicFactory');

// טעינת הגדרות הבוטים מתוך קובץ ה-JSON (החלפת ${VAR} נעשית per-bot בתוך startBot)
const botsConfig = JSON.parse(fs.readFileSync('./bots.json', 'utf8'));

// זמן המתנה (ms) לפני שליחת כל תגובה — מייצר תחושה טבעית יותר
const REPLY_DELAY_MS = 1500;

// זמן המתנה (ms) לפני שליחת תזכורת לנוטש באמצע הזמנה (10 דקות)
const CHURN_REMINDER_DELAY_MS = 10 * 60 * 1000;

// לאחר כמה ms של שתיקה ממשתמש מצרפים את כל הודעותיו ושולחים לGemini בבת אחת
const DEBOUNCE_MS = 3000;

/**
 * תור הודעות פשוט לשליטה על מספר הבקשות המקבילות.
 * מבטיח שלא יותר מ-`concurrency` הודעות יעובדו בו-זמנית,
 * ומונע קריסה בעומס גבוה ושליחה מהירה מדי שתיחשב ספאם על ידי WhatsApp.
 */
class MessageQueue {
    constructor(concurrency = 10) {
        this.concurrency = concurrency;
        this.running = 0;
        this.queue = [];
    }

    add(fn) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._drain();
        });
    }

    _drain() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const { fn, resolve, reject } = this.queue.shift();
            this.running++;
            fn().then(resolve, reject).finally(() => {
                this.running--;
                this._drain();
            });
        }
    }
}

function startBot(config) {
    // --- טעינת סודות הבוט הספציפי (secrets/<bot-id>/.env + service-account.json) ---
    // שימוש ב-path.resolve כדי להבטיח שהנתיב תמיד אבסולוטי (חשוב עבור PM2)
    const projectRoot = process.cwd();
    const secretsDir = path.resolve(projectRoot, config.secretsDir || '.');
    const envPath = path.join(secretsDir, '.env');

    let botEnv = {};
    try {
        if (fs.existsSync(envPath)) {
            const envRaw = fs.readFileSync(envPath, 'utf8');
            botEnv = dotenv.parse(envRaw);

            // בדיקה האם המשתנים נטענו (לצרכי דיבוג בלבד)
            const keys = Object.keys(botEnv);
            if (keys.length === 0) {
                console.error(`[${config.id}] ⚠️  .env file found at ${envPath} but it seems EMPTY or invalid.`);
            } else {
                console.log(`[${config.id}] ✅ Loaded ${keys.length} variables from .env`);
            }
        } else {
            console.error(`[${config.id}] ❌ .env file NOT FOUND at: ${envPath}`);
        }
    } catch (e) {
        console.error(`[${config.id}] ⚠️  Error reading .env from ${secretsDir}:`, e.message);
    }

    // החלפת ${VAR} בתצורת הבוט עם ערכים מה-.env הספציפי לו
    const resolvedConfig = JSON.parse(
        JSON.stringify(config).replace(/\$\{(\w+)\}/g, (_, key) => {
            const val = botEnv[key];
            if (!val) {
                // בדיקה אם זה משתנה סביבה של המערכת (fallback)
                const systemVal = process.env[key];
                if (systemVal) return systemVal;

                console.error(`[${config.id}] ⚠️  Missing env var in .env: ${key}`);
            }
            return val || '';
        })
    );

    console.log(`[System] Initializing ${resolvedConfig.displayName} (ID: ${config.id})...`);

    const gcpProject = botEnv.GCP_PROJECT || process.env.GCP_PROJECT;
    const gcpLocation = botEnv.GCP_LOCATION || process.env.GCP_LOCATION || 'us-central1';
    const serviceAccountPath = path.join(secretsDir, 'service-account.json');

    // --- Vertex AI Setup ---
    const vertexAI = new VertexAI({
        project: gcpProject,
        location: gcpLocation,
        googleAuthOptions: { keyFilename: serviceAccountPath },
    });

    // טעינת הכלים (tools) הספציפיים לבוט מתיקיית tools/
    const tools = require(`./tools/${resolvedConfig.toolsFile}`);

    let botCacheData = null; // { content: CachedContent, hash: string }

    async function getOrCreateCache(faqContent) {
        const today = new Date().toLocaleDateString('he-IL');

        const modelResourceName = `projects/${gcpProject}/locations/${gcpLocation}/publishers/google/models/gemini-2.5-flash`;

        const staticInstruction = resolvedConfig.systemInstruction
            .replace('${new Date().toLocaleDateString(\'he-IL\')}', today)
            .replace('{{FAQ}}', faqContent);

        const contentHash = crypto.createHash('md5').update(staticInstruction).digest('hex');

        if (botCacheData && botCacheData.hash === contentHash) {
            console.log(`[${resolvedConfig.displayName}] Reusing existing cache (content unchanged).`);
            return botCacheData.content;
        }

        const newCache = await vertexAI.preview.cachedContents.create({
            model: modelResourceName,
            systemInstruction: { role: 'system', parts: [{ text: staticInstruction }] },
            tools: tools,
            ttl: '86400s',
        });

        botCacheData = { content: newCache, hash: contentHash };
        console.log(`[${resolvedConfig.displayName}] Created new cache: ${newCache.name}`);
        return botCacheData.content;
    }

    // --- WhatsApp Client Setup ---
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: resolvedConfig.id }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    const sessions = new Map();
    const botTools = logicFactory[resolvedConfig.logicType](resolvedConfig);
    const messageQueue = new MessageQueue(10);

    // מניעת עיבוד כפול — message_create עלול לירות כמה פעמים על אותה הודעה
    const processedIds = new Set();

    // צבירת הודעות מהירות לפני שליחה לGemini (debounce)
    // מבנה: msgFrom → { timer, messages: [] }
    const userBuffers = new Map();

    client.on('qr', qr => {
        console.log(`\n[${resolvedConfig.displayName}] סרוק קוד עבור המספר ${resolvedConfig.whatsappNumber}:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => console.log(`[${resolvedConfig.displayName}] ONLINE`));

    client.on('message_create', async (msg) => {
        // התעלמות מקבוצות וסטטוסים
        if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;

        // --- מניעת עיבוד כפול ---
        // whatsapp-web.js יכול לירות message_create מספר פעמים לאותו ID
        const msgId = msg.id._serialized;
        if (processedIds.has(msgId)) return;
        processedIds.add(msgId);
        setTimeout(() => processedIds.delete(msgId), 5 * 60 * 1000);

        // --- זיהוי מספר השולח (כולל טיפול בפורמט @lid) ---
        // WhatsApp Multi-Device מזהה משתמשים לפעמים עם @lid במקום @c.us.
        // במקרה זה מספר הטלפון האמיתי מגיע דרך getContact().
        let senderNumber;
        if (msg.fromMe) {
            senderNumber = resolvedConfig.whatsappNumber;
        } else if (msg.from.includes('@lid')) {
            try {
                const contact = await msg.getContact();
                senderNumber = contact.number || msg.from.split('@')[0];
            } catch (e) {
                senderNumber = msg.from.split('@')[0];
            }
        } else {
            senderNumber = msg.from.split('@')[0];
        }

        // המרה לפורמט ישראלי (05...) במקום 972
        if (senderNumber && senderNumber.startsWith('972')) {
            senderNumber = '0' + senderNumber.substring(3);
        }

        const isAdmin = resolvedConfig.adminNumbers && resolvedConfig.adminNumbers.includes(senderNumber);

        // מניעת לופ: נאפשר הודעות יוצאות (fromMe) רק אם מדובר במנהל שכותב לעצמו (Self-chat).
        if (msg.fromMe) {
            const isSelfChat = msg.to === client.info.wid._serialized;
            if (!isAdmin || !isSelfChat) return;

            const chatSession = sessions.get(msg.from);
            if (chatSession && msg.body === chatSession.lastResponse) return;
        }

        // חסימת משתמשים רגילים מלשלוח פקודות מנהל
        if (msg.body && msg.body.startsWith('!') && !isAdmin) {
            console.log(`[${resolvedConfig.displayName}] Unauthorized admin access attempt from ${senderNumber}`);
            return;
        }

        // --- פקודות מנהל: עיבוד מיידי ללא debounce ---
        if (isAdmin && msg.body && msg.body.startsWith('!')) {
            console.log(`[${resolvedConfig.displayName}] Admin command from ${senderNumber}: ${msg.body}`);
            messageQueue.add(() => processMessage(msg, msg.body, null, senderNumber));
            return;
        }

        // --- Debounce: צבירת הודעות עד שהמשתמש מפסיק להקליד ---
        // אם המשתמש שולח כמה הודעות ברצף, כולן יצורפו להודעה אחת לפני שליחה לGemini.
        // כך נמנעת תגובה נפרדת לכל הודעה.
        let buffer = userBuffers.get(msg.from);
        if (!buffer) {
            buffer = { timer: null, messages: [] };
            userBuffers.set(msg.from, buffer);
        }
        buffer.messages.push(msg);

        if (buffer.timer) clearTimeout(buffer.timer);

        const capturedSenderNumber = senderNumber;
        buffer.timer = setTimeout(() => {
            userBuffers.delete(msg.from);

            const { messages } = buffer;
            const lastMsg = messages[messages.length - 1];

            // צירוף כל גופי ההודעות לטקסט אחד
            const combinedBody = messages
                .map(m => m.body || '')
                .filter(b => b.length > 0)
                .join('\n');

            // שימוש בהודעה הראשונה שמכילה מדיה (תמונה)
            const mediaMsg = messages.find(m => m.hasMedia) || null;

            if (messages.length > 1) {
                console.log(`[${resolvedConfig.displayName}] Debounced ${messages.length} messages from ${lastMsg.from}`);
            } else {
                console.log(`[${resolvedConfig.displayName}] Processing message from ${lastMsg.from}: ${combinedBody.substring(0, 60)}`);
            }

            messageQueue.add(() => processMessage(lastMsg, combinedBody, mediaMsg, capturedSenderNumber));
        }, DEBOUNCE_MS);
    });

    /**
     * עיבוד ההודעה: קריאה לGemini, הרצת function calls, ושליחת תגובה.
     * @param {object} msg       - הודעת ה-WhatsApp האחרונה בסדרה (לצורך reply/getChat)
     * @param {string} body      - הטקסט המשולב מכל ההודעות שנצברו ב-debounce
     * @param {object|null} mediaMsg - ההודעה שמכילה מדיה (אם קיימת)
     * @param {string} senderNumber  - מספר הטלפון המפוענח של השולח
     */
    async function processMessage(msg, body, mediaMsg, senderNumber) {
        try {
            // הזרקת מידע זמני להוראות המערכת
            const currentTime = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

            // טעינת שאלות ותשובות מקובץ חיצוני (אם קיים)
            let faqContent = "";
            try {
                const faqPath = `faq/${resolvedConfig.id}.txt`;
                if (fs.existsSync(faqPath)) {
                    faqContent = fs.readFileSync(faqPath, 'utf8');
                }
            } catch (err) {
                console.error(`Failed to read FAQ for ${resolvedConfig.id}:`, err.message);
            }

            // Get/create cache, then get a model bound to it
            const cache = await getOrCreateCache(faqContent);
            const cachedModel = vertexAI.preview.getGenerativeModelFromCachedContent(cache);

            let chatSession = sessions.get(msg.from);
            if (!chatSession) {
                chatSession = {
                    chat: cachedModel.startChat({}),
                    lastResponse: null,
                    orderCompleted: false,  // האם ההזמנה הושלמה בהצלחה (מאופס per-message)
                    orderSaved: false,      // האם הזמנה נשמרה אי-פעם בשיחה זו (לא מאופס)
                    reminderSent: false,    // האם כבר נשלחה תזכורת נטישה (מוגבל לפעם אחת)
                    reminderTimeout: null,  // מזהה ה-timeout של התזכורת
                };
                sessions.set(msg.from, chatSession);
            } else {
                chatSession.orderCompleted = false;
                if (chatSession.reminderTimeout) clearTimeout(chatSession.reminderTimeout);

                // Sliding window: retain only last 40 turns (20 user/model pairs).
                // A full delivery order can easily reach 15+ exchanges — 8 was too low
                // and caused the bot to forget addresses given early in the conversation.
                const fullHistory = await chatSession.chat.getHistory();
                const trimmedHistory = fullHistory.length > 40 ? fullHistory.slice(-40) : fullHistory;
                chatSession.chat = cachedModel.startChat({ history: trimmedHistory });
            }

            // --- תזמון תזכורת נטישה ---
            // שולח תזכורת אחת בלבד אם המשתמש לא מגיב, לא השלים הזמנה, ולא שמר הזמנה בעבר
            if (!chatSession.reminderSent && !chatSession.orderSaved) {
                chatSession.reminderTimeout = setTimeout(async () => {
                    if (!chatSession.orderSaved && !chatSession.reminderSent) {
                        chatSession.reminderSent = true;
                        try {
                            await client.sendMessage(
                                msg.from,
                                'היי! 😊 ראיתי שהתחלת הזמנה ולא סיימת. אם תרצה להמשיך — אני כאן בשבילך!'
                            );
                            console.log(`[${resolvedConfig.displayName}] Churn reminder sent to ${msg.from}`);
                        } catch (e) {
                            console.error(`[${resolvedConfig.displayName}] Failed to send churn reminder:`, e.message);
                        }
                    }
                }, CHURN_REMINDER_DELAY_MS);
            }

            const chat = chatSession.chat;

            const whatsappChat = await msg.getChat();
            await whatsappChat.sendStateTyping();

            // --- בניית חלקי ההודעה (טקסט + מדיה אם נשלחה תמונה) ---
            const messageParts = [];

            if (mediaMsg) {
                try {
                    const mediaData = await mediaMsg.downloadMedia();
                    if (mediaData && mediaData.data) {
                        messageParts.push({
                            inlineData: {
                                data: mediaData.data,
                                mimeType: mediaData.mimetype || 'image/jpeg',
                            }
                        });
                        console.log(`[${resolvedConfig.displayName}] Media received: ${mediaData.mimetype}`);
                    }
                } catch (e) {
                    console.error(`[${resolvedConfig.displayName}] Failed to download media:`, e.message);
                }
            }

            messageParts.push({ text: `[שעה: ${currentTime}]\n${body}` });

            let result = await chat.sendMessage(messageParts);
            let response = result.response;

            console.log(`[${resolvedConfig.displayName}] cachedContentTokenCount: ${response.usageMetadata?.cachedContentTokenCount ?? 'N/A'}`);

            // --- עיבוד function calls ---
            // Vertex AI מחזיר function calls דרך candidates[0].content.parts
            let calls = getFunctionCalls(response);
            let fileToSend = null;

            while (calls && calls.length > 0) {
                const functionResponseParts = [];
                for (const call of calls) {
                    // הזרקה אוטומטית של מספר השולח
                    const argsWithSender = { ...call.args, senderPhone: senderNumber };
                    console.log(`[${resolvedConfig.displayName}] 🔧 Tool call: ${call.name}`, JSON.stringify(call.args));
                    const toolResult = await botTools[call.name](argsWithSender);
                    console.log(`[${resolvedConfig.displayName}] ✅ Tool result: ${call.name}`, JSON.stringify(toolResult));

                    // זיהוי השלמת הזמנה — מבטל את תזכורת הנטישה ומסמן שהזמנה נשמרה לצמיתות
                    if (call.name === 'saveOrderToSheet' && toolResult?.success) {
                        chatSession.orderCompleted = true;
                        chatSession.orderSaved = true;
                        if (chatSession.reminderTimeout) clearTimeout(chatSession.reminderTimeout);
                    }

                    if (toolResult && toolResult.sendFile) {
                        fileToSend = toolResult.sendFile;
                    }
                    if (toolResult && toolResult.adminAlert) {
                        try {
                            await client.sendMessage(toolResult.adminNumber, toolResult.adminAlert);
                        } catch (err) {
                            console.error("Failed to send admin alert:", err.message);
                        }
                    }

                    functionResponseParts.push({
                        functionResponse: {
                            name: call.name,
                            response: toolResult
                        }
                    });
                }

                result = await chat.sendMessage(functionResponseParts);
                response = result.response;
                calls = getFunctionCalls(response);
            }

            // --- השהייה לפני שליחה + הפעלת טיפינג מחדש ---
            // מייצר תחושה טבעית ומונע שליחה מהירה מדי
            try { await whatsappChat.sendStateTyping(); } catch (e) { }
            await new Promise(resolve => setTimeout(resolve, REPLY_DELAY_MS));

            // --- שליחת תגובה ---
            const botText = getResponseText(response);
            if (chatSession) chatSession.lastResponse = botText;

            if (fileToSend) {
                const media = MessageMedia.fromFilePath(fileToSend);
                await msg.reply(media, undefined, { caption: botText });
                try { fs.unlinkSync(fileToSend); } catch (e) { console.error("Failed to delete temp file:", e); }
            } else {
                await msg.reply(botText);
            }

        } catch (error) {
            console.error(`[${resolvedConfig.id}] Error:`, error.message);

            const clientErrorMessage = "מצטערים, ארעה שגיאה טכנית קלה בזמן עיבוד הבקשה. המנהל קיבל עדכון ויצור איתך קשר בהקדם כדי להשלים את ההזמנה.";
            await msg.reply(clientErrorMessage);

            try {
                const adminErrorReport = `⚠️ *דיווח שגיאה בבוט:*\nמשתמש: ${senderNumber}\nהודעה: ${body}\nשגיאה: ${error.message}`;
                const adminJid = resolvedConfig.whatsappNumber.includes('@') ? resolvedConfig.whatsappNumber : `${resolvedConfig.whatsappNumber}@c.us`;
                await client.sendMessage(adminJid, adminErrorReport);
            } catch (adminErr) {
                console.error("Failed to notify admin about error:", adminErr.message);
            }
        }
    }

    client.initialize();
}

/**
 * מחלץ function calls מתגובת Vertex AI.
 * Vertex AI מחזיר אותם כ-parts עם שדה `functionCall`.
 */
function getFunctionCalls(response) {
    try {
        const parts = response?.candidates?.[0]?.content?.parts || [];
        return parts
            .filter(p => p.functionCall)
            .map(p => p.functionCall);
    } catch (e) {
        return [];
    }
}

/**
 * מחלץ את הטקסט מתגובת Vertex AI.
 */
function getResponseText(response) {
    try {
        const parts = response?.candidates?.[0]?.content?.parts || [];
        return parts
            .filter(p => p.text)
            .map(p => p.text)
            .join('');
    } catch (e) {
        return '';
    }
}

botsConfig.forEach(startBot);
