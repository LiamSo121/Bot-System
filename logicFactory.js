/**
 * Logic Factory - Business Specific Tools
 * מגדיר את הכלים הייחודיים לכל עסק (משלוחים, תורים וכו')
 */

const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');

const logicFactory = {
    /**
     * לוגיקה עבור ליאם שליחויות (Delivery Profile)
     */
    delivery: (config) => ({
        // אימות כתובת מול Google Maps
        validateAddress: async ({ address }) => {
            try {
                const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${config.mapsKey}&language=iw`;
                const res = await axios.get(url);
                if (res.data.status === 'OK') {
                    return {
                        success: true,
                        formatted_address: res.data.results[0].formatted_address
                    };
                }
                return { success: false, error: "הכתובת לא נמצאה במערכת המפות. נא לדייק (עיר, רחוב, מספר)." };
            } catch (e) {
                return { success: false, error: "שגיאה בתקשורת עם שירות המפות." };
            }
        },

        // אימות מספר טלפון (מתחיל ב-05 ובדיוק 10 ספרות)
        validatePhone: async ({ phone }) => {
            const cleanedPhone = phone.replace(/\D/g, ''); // מסיר כל תו שאינו ספרה
            const isValid = /^05\d{8}$/.test(cleanedPhone);
            return {
                success: isValid,
                formattedPhone: isValid ? cleanedPhone : null,
                error: isValid ? undefined : "מספר טלפון לא תקין. חייב להתחיל ב-05 ולהכיל 10 ספרות בדיוק."
            };
        },

        // חישוב מרחק ותמחור: 50 ש"ח בסיס + 5 ש"ח לכל ק"מ מעל 5 ק"מ
        calculateDistanceAndPrice: async ({ origin, destination }) => {
            try {
                const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&key=${config.mapsKey}&language=iw`;
                const res = await axios.get(url);

                if (res.data.rows[0].elements[0].status === 'OK') {
                    const distanceData = res.data.rows[0].elements[0].distance;
                    const distanceInKm = Math.ceil(distanceData.value / 1000);

                    let price = 50;
                    if (distanceInKm > 5) {
                        price += (distanceInKm - 5) * 5;
                    }

                    return {
                        success: true,
                        distance: `${distanceInKm}`,
                        price: `${price}`,
                        displayPrice: `${price} ש"ח`
                    };
                }
                return { success: false, error: "לא ניתן לחשב מרחק בין הנקודות." };
            } catch (e) {
                return { success: false, error: "שגיאה בחישוב המרחק." };
            }
        },

        // שמירה לטבלת גוגל שיטס (13 עמודות: A עד M)
        saveOrderToSheet: async (data) => {
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: 'service-account.json',
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                const row = [
                    data.date || new Date().toLocaleDateString('he-IL'),
                    data.time || new Date().toLocaleTimeString('he-IL'),
                    data.ordererName,
                    `'${data.senderPhone}`, // עמודה D: פלאפון המזמין
                    data.pickupAddress,
                    data.pickupContact,
                    `'${data.pickupPhone}`,
                    data.deliveryAddress,
                    data.deliveryContact,
                    `'${data.deliveryPhone}`,
                    data.distance,
                    data.price,
                    "לא", // סטטוס תשלום
                    "לא", // הושלם
                    data.packageDetails // פרטי משלוח (אוכל/חבילה/משקל וכו') - עמודה O
                ];

                await sheets.spreadsheets.values.append({
                    spreadsheetId: config.spreadsheetId,
                    range: 'A:O',
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [row] },
                });
                return { success: true, message: "ההזמנה נרשמה בהצלחה." };
            } catch (e) {
                console.error(`[${config.id}] Sheet Error:`, e.message);
                return { success: false, error: "שגיאה בכתיבה לטבלה." };
            }
        },

        // שמירת הזמנה ליומן גוגל
        saveOrderToCalendar: async (data) => {
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: 'service-account.json',
                    scopes: ['https://www.googleapis.com/auth/calendar.events'],
                });
                const calendar = google.calendar({ version: 'v3', auth });

                const event = {
                    summary: data.title,
                    location: data.location,
                    description: data.description,
                    start: {
                        dateTime: data.startTimeIso,
                        timeZone: 'Asia/Jerusalem',
                    },
                    end: {
                        dateTime: data.endTimeIso,
                        timeZone: 'Asia/Jerusalem',
                    },
                };

                await calendar.events.insert({
                    calendarId: config.calendarId,
                    resource: event,
                });
                return { success: true, message: "ההזמנה נשמרה ביומן בהצלחה." };
            } catch (e) {
                console.error(`[${config.id}] Calendar Error:`, e.message);
                return { success: false, error: "שגיאה בשמירה ליומן." };
            }
        },

        // קריאת משלוחים קיימים עבור המנהל
        getOrdersFromSheet: async () => {
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: 'service-account.json',
                    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: config.spreadsheetId,
                    range: 'A:O',
                });

                const rows = res.data.values;
                if (!rows || rows.length === 0) {
                    return { success: true, message: "אין נתונים בטבלה עדיין." };
                }

                // הפונקציה מחזירה את השורות (למעט שורת הכותרת אם יש)
                return {
                    success: true,
                    orders: rows
                };
            } catch (e) {
                console.error(`[${config.id}] Read Sheet Error:`, e.message);
                return { success: false, error: "שגיאה בקריאת נתונים מהטבלה." };
            }
        },

        // עדכון סטטוס הזמנה (תשלום והושלם) - עמודות L ו-M
        updateOrderStatusInSheet: async ({ ordererName, date, updatePayment, updateCompleted }) => {
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: 'service-account.json',
                    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                // 1. קריאת כל השורות כדי למצוא את השורה המתאימה
                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: config.spreadsheetId,
                    range: 'A:O',
                });

                const rows = res.data.values;
                if (!rows || rows.length === 0) {
                    return { success: false, error: "הטבלה ריקה." };
                }

                // חיפוש השורה החופפת: שם מזמין ותאריך
                let rowIndex = -1;
                for (let i = 0; i < rows.length; i++) {
                    const row = rows[i];
                    // ערוץ A הוא התאריך (אינדקס 0), ערוץ C הוא שם המזמין (אינדקס 2)
                    if (row[0] === date && row[2] === ordererName) {
                        rowIndex = i;
                        break;
                    }
                }

                if (rowIndex === -1) {
                    return { success: false, error: `לא נמצאה הזמנה עבור '${ordererName}' בתאריך '${date}'.` };
                }

                // 2. עדכון השורה הספציפית
                // שורות בגוגל שיטס מתחילות מ-1, לכן אינדקס 0 הוא שורה 1
                const sheetRowNumber = rowIndex + 1;
                const rangeToUpdate = `M${sheetRowNumber}:N${sheetRowNumber}`;

                // נשמור על הערכים הקיימים אם לא ביקשו לעדכן אותם במפורש
                // אינדקסים מעודכנים אחרי הזזת פלאפון המזמין לעמודה D (אינדקס 3)
                // עמודות M ו-N הן אינדקס 12 ו-13
                const currentPayment = rows[rowIndex][12] || "לא";
                const currentCompleted = rows[rowIndex][13] || "לא";

                const newValues = [
                    [
                        updatePayment !== undefined && updatePayment !== "" ? updatePayment : currentPayment,
                        updateCompleted !== undefined && updateCompleted !== "" ? updateCompleted : currentCompleted
                    ]
                ];

                await sheets.spreadsheets.values.update({
                    spreadsheetId: config.spreadsheetId,
                    range: rangeToUpdate,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: newValues },
                });

                return { success: true, message: "הסטטוסים עודכנו בהצלחה." };

            } catch (e) {
                console.error(`[${config.id}] Update Sheet Error:`, e.message);
                return { success: false, error: "שגיאה בעדכון הטבלה." };
            }
        },

        // הפקת דוח אקסל (CSV) למנהל
        generateOrdersReport: async () => {
            try {
                const auth = new google.auth.GoogleAuth({
                    keyFile: 'service-account.json',
                    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
                });
                const sheets = google.sheets({ version: 'v4', auth });

                const res = await sheets.spreadsheets.values.get({
                    spreadsheetId: config.spreadsheetId,
                    range: 'A:N',
                });

                const rows = res.data.values;
                if (!rows || rows.length === 0) {
                    return { success: false, error: "אין נתונים בטבלה להפקת דוח." };
                }

                // המרה ל-CSV
                let csvContent = '\uFEFF'; // BOM לעברית תקינה באקסל
                rows.forEach(row => {
                    // טיפול בפסיקים בתוך מחרוזות כדי שלא ישברו עמודות
                    const cleanRow = row.map(cell => {
                        const cellStr = cell ? String(cell) : "";
                        if (cellStr.includes(',') || cellStr.includes('"')) {
                            return `"${cellStr.replace(/"/g, '""')}"`;
                        }
                        return cellStr;
                    });
                    csvContent += cleanRow.join(',') + '\r\n';
                });

                const filePath = `report_${Date.now()}.csv`;
                fs.writeFileSync(filePath, csvContent);

                return {
                    success: true,
                    message: "הדוח נוצר בהצלחה ויישלח עכשיו.",
                    sendFile: filePath // דגל מיוחד שאומר ל-index.js לשלוח את הקובץ
                };
            } catch (e) {
                console.error(`[${config.id}] Report Generation Error:`, e.message);
                return { success: false, error: "שגיאה ביצירת הדוח." };
            }
        },

        // שליחת התראה למנהל במקרה של שאלה לא פתורה
        notifyAdmin: async ({ message, senderInfo }) => {
            try {
                // נשלח את ההתראה למספר המנהל הראשי
                const adminMessage = `❓ *שאלה חדשה שלא נענתה על ידי הבוט:*\nמשתמש: ${senderInfo}\nשאלה: ${message}\nנא לחזור ללקוח בהקדם.`;
                return {
                    success: true,
                    message: "הבקשה הועברה למנהל.",
                    adminAlert: adminMessage,
                    adminNumber: `${config.whatsappNumber}@c.us`
                };
            } catch (e) {
                console.error(`[${config.id}] Notify Admin Error:`, e.message);
                return { success: false, error: "שגיאה בהודעה למנהל." };
            }
        }
    })
};

module.exports = logicFactory;