/**
 * WhatsApp Multi-Tenant SaaS Engine
 * המנוע המרכזי הגנרי - אין כאן שום לוגיקה ספציפית לבוט מסוים.
 * כל ההתאמות נמצאות ב: tools/, logicFactory.js, bots.json
 */

const fs = require('fs');
const crypto = require('crypto');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { VertexAI } = require('@google-cloud/vertexai');
require('dotenv').config();

const logicFactory = require('./logicFactory');

// טעינת הגדרות הבוטים מתוך קובץ ה-JSON + החלפת משתני env
const botsConfigRaw = fs.readFileSync('./bots.json', 'utf8');
const botsConfigInterpolated = botsConfigRaw.replace(/\$\{(\w+)\}/g, (_, key) => {
    const value = process.env[key];
    if (!value) {
        console.error(`[System] ⚠️  Missing environment variable: ${key}`);
    }
    return value || '';
});
const botsConfig = JSON.parse(botsConfigInterpolated);

// אימות Vertex AI דרך service-account.json
process.env.GOOGLE_APPLICATION_CREDENTIALS = './service-account.json';

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
    console.log(`[System] Initializing ${config.displayName}...`);

    // --- Vertex AI Setup ---
    const vertexAI = new VertexAI({
        project: process.env.GCP_PROJECT,
        location: process.env.GCP_LOCATION || 'us-central1',
    });

    // טעינת הכלים (tools) הספציפיים לבוט מתיקיית tools/
    const tools = require(`./tools/${config.toolsFile}`);

    let botCacheData = null; // { content: CachedContent, hash: string }

    async function getOrCreateCache(faqContent) {
        const today = new Date().toLocaleDateString('he-IL');

        const location = process.env.GCP_LOCATION || 'us-central1';
        const modelResourceName = `projects/${process.env.GCP_PROJECT}/locations/${location}/publishers/google/models/gemini-2.5-flash`;

        const staticInstruction = config.systemInstruction
            .replace('${new Date().toLocaleDateString(\'he-IL\')}', today)
            .replace('{{FAQ}}', faqContent);

        const contentHash = crypto.createHash('md5').update(staticInstruction).digest('hex');

        if (botCacheData && botCacheData.hash === contentHash) {
            console.log(`[${config.displayName}] Reusing existing cache (content unchanged).`);
            return botCacheData.content;
        }

        const newCache = await vertexAI.preview.cachedContents.create({
            model: modelResourceName,
            systemInstruction: { role: 'system', parts: [{ text: staticInstruction }] },
            tools: tools,
            ttl: '86400s',
        });

        botCacheData = { content: newCache, hash: contentHash };
        console.log(`[${config.displayName}] Created new cache: ${newCache.name}`);
        return botCacheData.content;
    }

    // --- WhatsApp Client Setup ---
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: config.id }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    const sessions = new Map();
    const botTools = logicFactory[config.logicType](config);
    const messageQueue = new MessageQueue(10);

    // מניעת עיבוד כפול — message_create עלול לירות כמה פעמים על אותה הודעה
    const processedIds = new Set();

    // צבירת הודעות מהירות לפני שליחה לGemini (debounce)
    // מבנה: msgFrom → { timer, messages: [] }
    const userBuffers = new Map();

    client.on('qr', qr => {
        console.log(`\n[${config.displayName}] סרוק קוד עבור המספר ${config.whatsappNumber}:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => console.log(`[${config.displayName}] ONLINE`));

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
            senderNumber = config.whatsappNumber;
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

        const isAdmin = config.adminNumbers && config.adminNumbers.includes(senderNumber);

        // מניעת לופ: נאפשר הודעות יוצאות (fromMe) רק אם מדובר במנהל שכותב לעצמו (Self-chat).
        if (msg.fromMe) {
            const isSelfChat = msg.to === client.info.wid._serialized;
            if (!isAdmin || !isSelfChat) return;

            const chatSession = sessions.get(msg.from);
            if (chatSession && msg.body === chatSession.lastResponse) return;
        }

        // חסימת משתמשים רגילים מלשלוח פקודות מנהל
        if (msg.body && msg.body.startsWith('!') && !isAdmin) {
            console.log(`[${config.displayName}] Unauthorized admin access attempt from ${senderNumber}`);
            return;
        }

        // --- פקודות מנהל: עיבוד מיידי ללא debounce ---
        if (isAdmin && msg.body && msg.body.startsWith('!')) {
            console.log(`[${config.displayName}] Admin command from ${senderNumber}: ${msg.body}`);
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
                console.log(`[${config.displayName}] Debounced ${messages.length} messages from ${lastMsg.from}`);
            } else {
                console.log(`[${config.displayName}] Processing message from ${lastMsg.from}: ${combinedBody.substring(0, 60)}`);
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
                const faqPath = `faq/${config.id}.txt`;
                if (fs.existsSync(faqPath)) {
                    faqContent = fs.readFileSync(faqPath, 'utf8');
                }
            } catch (err) {
                console.error(`Failed to read FAQ for ${config.id}:`, err.message);
            }

            // Get/create cache, then get a model bound to it
            const cache = await getOrCreateCache(faqContent);
            const cachedModel = vertexAI.preview.getGenerativeModelFromCachedContent(cache);

            let chatSession = sessions.get(msg.from);
            if (!chatSession) {
                chatSession = {
                    chat: cachedModel.startChat({}),
                    lastResponse: null,
                    orderCompleted: false,  // האם ההזמנה הושלמה בהצלחה
                    reminderSent: false,    // האם כבר נשלחה תזכורת נטישה (מוגבל לפעם אחת)
                    reminderTimeout: null,  // מזהה ה-timeout של התזכורת
                };
                sessions.set(msg.from, chatSession);
            } else {
                // איפוס מצב הזמנה — כל הודעה חדשה מאפסת את מצב ה-orderCompleted
                // אך reminderSent לא מאופס כדי למנוע הטרדה חוזרת
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
            // שולח תזכורת אחת בלבד אם המשתמש לא מגיב ולא השלים הזמנה
            if (!chatSession.reminderSent) {
                chatSession.reminderTimeout = setTimeout(async () => {
                    if (!chatSession.orderCompleted && !chatSession.reminderSent) {
                        chatSession.reminderSent = true;
                        try {
                            await client.sendMessage(
                                msg.from,
                                'היי! 😊 ראיתי שהתחלת הזמנה ולא סיימת. אם תרצה להמשיך — אני כאן בשבילך!'
                            );
                            console.log(`[${config.displayName}] Churn reminder sent to ${msg.from}`);
                        } catch (e) {
                            console.error(`[${config.displayName}] Failed to send churn reminder:`, e.message);
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
                        console.log(`[${config.displayName}] Media received: ${mediaData.mimetype}`);
                    }
                } catch (e) {
                    console.error(`[${config.displayName}] Failed to download media:`, e.message);
                }
            }

            messageParts.push({ text: `[שעה: ${currentTime}]\n${body}` });

            let result = await chat.sendMessage(messageParts);
            let response = result.response;

            console.log(`[${config.displayName}] cachedContentTokenCount: ${response.usageMetadata?.cachedContentTokenCount ?? 'N/A'}`);

            // --- עיבוד function calls ---
            // Vertex AI מחזיר function calls דרך candidates[0].content.parts
            let calls = getFunctionCalls(response);
            let fileToSend = null;

            while (calls && calls.length > 0) {
                const functionResponseParts = [];
                for (const call of calls) {
                    // הזרקה אוטומטית של מספר השולח
                    const argsWithSender = { ...call.args, senderPhone: senderNumber };
                    const toolResult = await botTools[call.name](argsWithSender);

                    // זיהוי השלמת הזמנה — מבטל את תזכורת הנטישה
                    if (call.name === 'saveOrderToSheet' && toolResult?.success) {
                        chatSession.orderCompleted = true;
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
            try { await whatsappChat.sendStateTyping(); } catch (e) {}
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
            console.error(`[${config.id}] Error:`, error.message);

            const clientErrorMessage = "מצטערים, ארעה שגיאה טכנית קלה בזמן עיבוד הבקשה. המנהל קיבל עדכון ויצור איתך קשר בהקדם כדי להשלים את ההזמנה.";
            await msg.reply(clientErrorMessage);

            try {
                const adminErrorReport = `⚠️ *דיווח שגיאה בבוט:*\nמשתמש: ${senderNumber}\nהודעה: ${body}\nשגיאה: ${error.message}`;
                const adminJid = config.whatsappNumber.includes('@') ? config.whatsappNumber : `${config.whatsappNumber}@c.us`;
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
