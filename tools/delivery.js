/**
 * tools/delivery.js
 * הגדרת כלי ה-AI עבור בוט ליאם שליחויות.
 * מוחזר כמערך tools שמועבר ל-VertexAI model.
 */

const { FunctionDeclarationSchemaType } = require('@google-cloud/vertexai');

module.exports = [
    {
        functionDeclarations: [
            {
                name: "validateAddress",
                description: "Validate an address using Google Maps. Call this for ANY pickup or delivery address the user provides to ensure it is accurate.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: { address: { type: FunctionDeclarationSchemaType.STRING, description: "The address to validate" } },
                    required: ["address"]
                }
            },
            {
                name: "validatePhone",
                description: "Validate a phone number to ensure it starts with 05 and has exactly 10 digits.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: { phone: { type: FunctionDeclarationSchemaType.STRING, description: "The phone number to validate" } },
                    required: ["phone"]
                }
            },
            {
                name: "calculateDistanceAndPrice",
                description: "Calculate distance and price between two addresses. Call this when both pickup and delivery addresses are verified.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {
                        origin: { type: FunctionDeclarationSchemaType.STRING, description: "The pickup address" },
                        destination: { type: FunctionDeclarationSchemaType.STRING, description: "The delivery address" },
                        isImmediate: { type: FunctionDeclarationSchemaType.BOOLEAN, description: "Set to true if the user requested immediate delivery. Adds a 20 NIS surcharge to the price." }
                    },
                    required: ["origin", "destination"]
                }
            },
            {
                name: "saveOrderToSheet",
                description: "Save the final order details to Google Sheets. Call this ONLY after the user confirms the final summary with 'מאשר'.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {
                        time: { type: FunctionDeclarationSchemaType.STRING, description: "Time of order" },
                        ordererName: { type: FunctionDeclarationSchemaType.STRING, description: "Name of the person ordering" },
                        pickupAddress: { type: FunctionDeclarationSchemaType.STRING, description: "Full pickup address" },
                        pickupContact: { type: FunctionDeclarationSchemaType.STRING, description: "Pickup contact name" },
                        pickupPhone: { type: FunctionDeclarationSchemaType.STRING, description: "Pickup contact phone" },
                        deliveryAddress: { type: FunctionDeclarationSchemaType.STRING, description: "Full delivery address" },
                        deliveryContact: { type: FunctionDeclarationSchemaType.STRING, description: "Delivery contact name" },
                        deliveryPhone: { type: FunctionDeclarationSchemaType.STRING, description: "Delivery contact phone" },
                        distance: { type: FunctionDeclarationSchemaType.STRING, description: "Calculated distance in KM" },
                        price: { type: FunctionDeclarationSchemaType.STRING, description: "Calculated price" },
                        packageDetails: { type: FunctionDeclarationSchemaType.STRING, description: "Type of delivery (food/envelope/package) and package details (weight, fragile) if applicable." },
                        deliveryDate: { type: FunctionDeclarationSchemaType.STRING, description: "Scheduled delivery date (e.g. '26/02/2026'). Use 'מיידי' if immediate." },
                        deliveryTime: { type: FunctionDeclarationSchemaType.STRING, description: "Scheduled delivery time (e.g. '14:00'). Use 'מיידי' if immediate." }
                    },
                    required: ["ordererName", "pickupAddress", "pickupContact", "pickupPhone", "deliveryAddress", "deliveryContact", "deliveryPhone", "distance", "price", "packageDetails", "deliveryDate", "deliveryTime"]
                }
            },
            {
                name: "getOrdersFromSheet",
                description: "Read existing orders from Google Sheets. Call this ONLY when the admin (the user whose message starts with '!') asks for a summary, details, or status of existing deliveries.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: "updateOrderStatusInSheet",
                description: "Update the payment ('סטטוס תשלום') and/or completion ('הושלם') status of an existing order. Use this when the admin asks to mark an order as paid or completed.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {
                        ordererName: { type: FunctionDeclarationSchemaType.STRING, description: "The name of the person who originally ordered (from column C)." },
                        date: { type: FunctionDeclarationSchemaType.STRING, description: "The date of the order (from column A)." },
                        updatePayment: { type: FunctionDeclarationSchemaType.STRING, description: "Optional. Set to 'כן' or 'לא' if updating payment status." },
                        updateCompleted: { type: FunctionDeclarationSchemaType.STRING, description: "Optional. Set to 'כן' or 'לא' if updating completion status." }
                    },
                    required: ["ordererName", "date"]
                }
            },
            {
                name: "generateOrdersReport",
                description: "Generate and send an Excel/CSV report of the orders to the admin. Use this ONLY when the admin explicitly asks for a file, excel, report, csv, or a document of the orders.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: "saveOrderToCalendar",
                description: "Save the order to Google Calendar. Call this right after saveOrderToSheet when the user confirms the order.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {
                        title: { type: FunctionDeclarationSchemaType.STRING, description: "Title of the calendar event (e.g. 'משלוח: שם הלקוח')" },
                        description: { type: FunctionDeclarationSchemaType.STRING, description: "Full details of the delivery to put in the event description (contacts, phones, full addresses, price, distance)." },
                        location: { type: FunctionDeclarationSchemaType.STRING, description: "Pickup address" },
                        startTimeIso: { type: FunctionDeclarationSchemaType.STRING, description: "Start time of the delivery in ISO 8601 format (e.g. 2026-02-21T13:00:00+02:00)." },
                        endTimeIso: { type: FunctionDeclarationSchemaType.STRING, description: "End time of the delivery in ISO 8601 format (e.g. 2026-02-21T14:00:00+02:00). Usually 1-2 hours after start time." }
                    },
                    required: ["title", "description", "location", "startTimeIso", "endTimeIso"]
                }
            },
            {
                name: "getCustomerHistory",
                description: "Check if the customer has placed an order before. Call this ONCE at the very start of every new conversation, before asking any questions. Returns isKnownCustomer (bool), customerName, lastPickupAddress, and lastOrderDate if known.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {},
                    required: []
                }
            },
            {
                name: "notifyAdmin",
                description: "Notify the human manager in two cases: (1) A user asks a question the bot cannot answer and the answer is NOT in the FAQ. (2) The user shows clear signs of frustration, anger, or impatience — such as excessive punctuation ('!!!!', '????'), ALL CAPS writing, or phrases like 'terrible', 'useless', 'why is this taking so long', 'I give up'. In case (2), include 'לקוח מתוסכל' in the senderInfo field so the admin knows to intervene immediately.",
                parameters: {
                    type: FunctionDeclarationSchemaType.OBJECT,
                    properties: {
                        message: { type: FunctionDeclarationSchemaType.STRING, description: "The user's original question" },
                        senderInfo: { type: FunctionDeclarationSchemaType.STRING, description: "The user's name or phone number" }
                    },
                    required: ["message", "senderInfo"]
                }
            }
        ]
    }
];
