/**
 * WhatsApp Multi-Tenant SaaS Engine
 * המנוע המרכזי שדרכו הכל רץ.
 */

const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
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

function startBot(config) {
    console.log(`[System] Initializing ${config.displayName}...`);

    const genAI = new GoogleGenerativeAI(config.geminiKey);

    const tools = [{
        functionDeclarations: [
            {
                name: "validateAddress",
                description: "Validate an address using Google Maps. Call this for ANY pickup or delivery address the user provides to ensure it is accurate.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: { address: { type: SchemaType.STRING, description: "The address to validate" } },
                    required: ["address"]
                }
            },
            {
                name: "validatePhone",
                description: "Validate a phone number to ensure it starts with 05 and has exactly 10 digits.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: { phone: { type: SchemaType.STRING, description: "The phone number to validate" } },
                    required: ["phone"]
                }
            },
            {
                name: "calculateDistanceAndPrice",
                description: "Calculate distance and price between two addresses. Call this when both pickup and delivery addresses are verified.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        origin: { type: SchemaType.STRING, description: "The pickup address" },
                        destination: { type: SchemaType.STRING, description: "The delivery address" }
                    },
                    required: ["origin", "destination"]
                }
            },
            {
                name: "saveOrderToSheet",
                description: "Save the final order details to Google Sheets. Call this ONLY after the user confirms the final summary with 'מאשר'.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        time: { type: SchemaType.STRING, description: "Time of order" },
                        ordererName: { type: SchemaType.STRING, description: "Name of the person ordering" },
                        pickupAddress: { type: SchemaType.STRING, description: "Full pickup address" },
                        pickupContact: { type: SchemaType.STRING, description: "Pickup contact name" },
                        pickupPhone: { type: SchemaType.STRING, description: "Pickup contact phone" },
                        deliveryAddress: { type: SchemaType.STRING, description: "Full delivery address" },
                        deliveryContact: { type: SchemaType.STRING, description: "Delivery contact name" },
                        deliveryPhone: { type: SchemaType.STRING, description: "Delivery contact phone" },
                        distance: { type: SchemaType.STRING, description: "Calculated distance in KM" },
                        price: { type: SchemaType.STRING, description: "Calculated price" },
                        packageDetails: { type: SchemaType.STRING, description: "Type of delivery (food/envelope/package) and package details (weight, fragile) if applicable." }
                    },
                    required: ["ordererName", "pickupAddress", "pickupContact", "pickupPhone", "deliveryAddress", "deliveryContact", "deliveryPhone", "distance", "price", "packageDetails"]
                }
            },
            {
                name: "getOrdersFromSheet",
                description: "Read existing orders from Google Sheets. Call this ONLY when the admin (the user whose message starts with '!') asks for a summary, details, or status of existing deliveries.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: "updateOrderStatusInSheet",
                description: "Update the payment ('סטטוס תשלום') and/or completion ('הושלם') status of an existing order. Use this when the admin asks to mark an order as paid or completed.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        ordererName: { type: SchemaType.STRING, description: "The name of the person who originally ordered (from column C)." },
                        date: { type: SchemaType.STRING, description: "The date of the order (from column A)." },
                        updatePayment: { type: SchemaType.STRING, description: "Optional. Set to 'כן' or 'לא' if updating payment status." },
                        updateCompleted: { type: SchemaType.STRING, description: "Optional. Set to 'כן' or 'לא' if updating completion status." }
                    },
                    required: ["ordererName", "date"]
                }
            },
            {
                name: "generateOrdersReport",
                description: "Generate and send an Excel/CSV report of the orders to the admin. Use this ONLY when the admin explicitly asks for a file, excel, report, csv, or a document of the orders.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: "saveOrderToCalendar",
                description: "Save the order to Google Calendar. Call this right after saveOrderToSheet when the user confirms the order.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        title: { type: SchemaType.STRING, description: "Title of the calendar event (e.g. 'משלוח: שם הלקוח')" },
                        description: { type: SchemaType.STRING, description: "Full details of the delivery to put in the event description (contacts, phones, full addresses, price, distance)." },
                        location: { type: SchemaType.STRING, description: "Pickup address" },
                        startTimeIso: { type: SchemaType.STRING, description: "Start time of the delivery in ISO 8601 format (e.g. 2026-02-21T13:00:00+02:00)." },
                        endTimeIso: { type: SchemaType.STRING, description: "End time of the delivery in ISO 8601 format (e.g. 2026-02-21T14:00:00+02:00). Usually 1-2 hours after start time." }
                    },
                    required: ["title", "description", "location", "startTimeIso", "endTimeIso"]
                }
            },
            {
                name: "notifyAdmin",
                description: "Notify the human manager when a user asks a question the bot cannot answer. Use this only when the answer is NOT in the FAQ.",
                parameters: {
                    type: SchemaType.OBJECT,
                    properties: {
                        message: { type: SchemaType.STRING, description: "The user's original question" },
                        senderInfo: { type: SchemaType.STRING, description: "The user's name or phone number" }
                    },
                    required: ["message", "senderInfo"]
                }
            }
        ]
    }];

    const model = genAI.getGenerativeModel({
        model: "gemini-2.5-flash",
        tools: tools
    });

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

        // זיהוי השולח: אם זאת הודעה שאנחנו שלחנו, השולח הוא המספר של הבוט. אחרת זה מי ששלח לנו.
        let senderNumber = msg.fromMe ? config.whatsappNumber : msg.from.replace('@c.us', '');

        // המרה לפורמט ישראלי (05...) במקום 972
        if (senderNumber.startsWith('972')) {
            senderNumber = '0' + senderNumber.substring(3);
        }
        const isAdmin = config.adminNumbers && config.adminNumbers.includes(senderNumber);

        // מניעת לופ: נאפשר הודעות יוצאות (fromMe) רק אם מדובר במנהל שכותב לעצמו (Self-chat).
        if (msg.fromMe) {
            const isSelfChat = msg.to === client.info.wid._serialized;

            // אם זה לא מנהל או לא סלף-צ'אט - נתעלם (הבוט לא צריך לענות כשהמנהל מדבר עם אחרים)
            if (!isAdmin || !isSelfChat) return;

            // הגנה נוספת מניעת לופ: אם זה סלף-צ'אט, נוודא שלא מדובר בתגובה אוטומטית של הבוט
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

            // טעינת שאלות ותשובות מקובץ חיצוני
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
                        history: [],
                        systemInstruction: { parts: [{ text: dynamicInstruction }] }
                    }),
                    lastInstruction: dynamicInstruction
                };
                sessions.set(msg.from, chatSession);
            } else {
                // אם ההוראות השתנו (למשל השעה השתנתה), נתחיל שיחה חדשה עם אותה היסטוריה אבל הוראות מעודכנות
                const history = await chatSession.chat.getHistory();
                chatSession.chat = model.startChat({
                    history: history,
                    systemInstruction: { parts: [{ text: dynamicInstruction }] }
                });
                chatSession.lastInstruction = dynamicInstruction; // Update the last instruction used
            }

            const chat = chatSession.chat;

            const whatsappChat = await msg.getChat();
            await whatsappChat.sendStateTyping();

            let result = await chat.sendMessage(msg.body);
            let response = result.response;

            let calls = response.functionCalls();
            let fileToSend = null;

            while (calls && calls.length > 0) {
                const results = [];
                for (const call of calls) {
                    // הזרקה אוטומטית של מספר השולח לכלים שזקוקים לזה (כמו saveOrderToSheet)
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
                    results.push({ functionResponse: { name: call.name, response: toolResult } });
                }
                result = await chat.sendMessage(results);
                response = result.response;
                calls = response.functionCalls();
            }

            if (fileToSend) {
                const media = MessageMedia.fromFilePath(fileToSend);
                const botText = response.text();
                // שמירת התגובה האחרונה למניעת לופים
                if (chatSession) chatSession.lastResponse = botText;
                await msg.reply(media, undefined, { caption: botText });
                try {
                    fs.unlinkSync(fileToSend);
                } catch (err) {
                    console.error("Failed to delete temp file:", err);
                }
            } else {
                const botText = response.text();
                // שמירת התגובה האחרונה למניעת לופים
                if (chatSession) chatSession.lastResponse = botText;
                await msg.reply(botText);
            }
        } catch (error) {
            console.error(`[${config.id}] Error:`, error.message);

            // הודעה ידידותית ללקוח
            const clientErrorMessage = "מצטערים, ארעה שגיאה טכנית קלה בזמן עיבוד הבקשה. המנהל קיבל עדכון ויצור איתך קשר בהקדם כדי להשלים את ההזמנה.";
            await msg.reply(clientErrorMessage);

            // דיווח טכני למנהל (למספר של הבוט עצמו/מנהל)
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

botsConfig.forEach(startBot);