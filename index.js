/**
 * WhatsApp Multi-Tenant SaaS Engine
 * המנוע המרכזי הגנרי - אין כאן שום לוגיקה ספציפית לבוט מסוים.
 * כל ההתאמות נמצאות ב: tools/, logicFactory.js, bots.json
 */

const fs = require('fs');
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

function startBot(config) {
    console.log(`[System] Initializing ${config.displayName}...`);

    // --- Vertex AI Setup ---
    const vertexAI = new VertexAI({
        project: process.env.GCP_PROJECT,
        location: process.env.GCP_LOCATION || 'us-central1',
    });

    // טעינת הכלים (tools) הספציפיים לבוט מתיקיית tools/
    const tools = require(`./tools/${config.toolsFile}`);

    const model = vertexAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        tools: tools,
    });

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

    client.on('qr', qr => {
        console.log(`\n[${config.displayName}] סרוק קוד עבור המספר ${config.whatsappNumber}:`);
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => console.log(`[${config.displayName}] ONLINE`));

    client.on('message_create', async (msg) => {
        // התעלמות מקבוצות
        if (msg.from.includes('@g.us')) return;

        // זיהוי השולח: אם זאת הודעה שאנחנו שלחנו, השולח הוא המספר של הבוט.
        let senderNumber = msg.fromMe ? config.whatsappNumber : msg.from.replace('@c.us', '');

        // המרה לפורמט ישראלי (05...) במקום 972
        if (senderNumber.startsWith('972')) {
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
        if (msg.body.startsWith('!') && !isAdmin) {
            console.log(`[${config.displayName}] Unauthorized admin access attempt from ${senderNumber}`);
            return;
        }

        console.log(`[${config.displayName}] Processing message from ${msg.from}: ${msg.body}`);

        try {
            // הזרקת מידע זמני להוראות המערכת
            const currentTime = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

            // טעינת שאלות ותשובות מקובץ חיצוני (אם קיים)
            let faqContent = "";
            try {
                if (fs.existsSync('faq_deliveries.txt')) {
                    faqContent = fs.readFileSync('faq_deliveries.txt', 'utf8');
                }
            } catch (err) {
                console.error("Failed to read faq_deliveries.txt:", err.message);
            }

            const dynamicInstruction = config.systemInstruction
                .replace('${new Date().toLocaleDateString(\'he-IL\')}', new Date().toLocaleDateString('he-IL'))
                .replace('{{FAQ}}', faqContent)
                + `\nהשעה הנוכחית היא: ${currentTime}.`;

            let chatSession = sessions.get(msg.from);
            if (!chatSession) {
                chatSession = {
                    chat: model.startChat({
                        systemInstruction: { parts: [{ text: dynamicInstruction }] }
                    }),
                    lastInstruction: dynamicInstruction
                };
                sessions.set(msg.from, chatSession);
            } else {
                // עדכון ה-instruction (למשל אם השעה השתנתה)
                const history = await chatSession.chat.getHistory();
                chatSession.chat = model.startChat({
                    history: history,
                    systemInstruction: { parts: [{ text: dynamicInstruction }] }
                });
                chatSession.lastInstruction = dynamicInstruction;
            }

            const chat = chatSession.chat;

            const whatsappChat = await msg.getChat();
            await whatsappChat.sendStateTyping();

            let result = await chat.sendMessage(msg.body);
            let response = result.response;

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
                const adminErrorReport = `⚠️ *דיווח שגיאה בבוט:*\nמשתמש: ${senderNumber}\nהודעה: ${msg.body}\nשגיאה: ${error.message}`;
                await client.sendMessage(`${config.whatsappNumber}@c.us`, adminErrorReport);
            } catch (adminErr) {
                console.error("Failed to notify admin about error:", adminErr.message);
            }
        }
    });

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