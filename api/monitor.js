const axios = require('axios');

// === CẤU HÌNH ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET || "default-secret-change-me";

// === HÀM GỬI TIN NHẮN TELEGRAM ===
async function sendTelegramMessage(chatId, message) {
    if (!BOT_TOKEN) return false;
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text: message, parse_mode: "Markdown" });
        return true;
    } catch (error) {
        console.error("Lỗi gửi Telegram:", error.message);
        return false;
    }
}

// === CHECK STATUS FACEBOOK (CẢI TIẾN) ===
async function checkFbStatus(userId) {
    const url = `https://www.facebook.com/${userId}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
    };
    
    try {
        const response = await axios.get(url, { 
            headers, 
            timeout: 15000,
            maxRedirects: 5
        });
        
        const text = response.data.toLowerCase();
        
        // Phát hiện các trang lỗi tạm thời
        if (text.includes("checkpoint") || text.includes("login_required")) {
            return "ERROR";
        }
        
        // Phát hiện account thực sự bị vô hiệu
        if (text.includes("disabled") || text.includes("temporarily locked")) {
            return "DIE";
        }
        
        // Phát hiện account không tồn tại
        if (text.includes("not found") || text.includes("this page isn't available")) {
            return "DIE";
        }
        
        // Mặc định là LIVE nếu status 200
        if (response.status === 200) {
            return "LIVE";
        }
        
        return "UNKNOWN";
        
    } catch (error) {
        if (error.response && error.response.status === 404) return "DIE";
        return "ERROR";
    }
}

// === HÀM RETRY ===
async function checkWithRetry(userId, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        const result = await checkFbStatus(userId);
        if (result !== "ERROR") return result;
        if (i < retries) {
            console.log(`🔄 Retry ${userId}...`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    return "ERROR";
}

// === XỬ LÝ LỆNH TELEGRAM ===
async function handleCommand(messageText, chatId) {
    const cmd = messageText.trim().toLowerCase();
    
    if (cmd === '/start' || cmd === '/help') {
        const help = `🤖 *FACEBOOK MONITOR BOT*\n\n可用命令:\n/add <id> - Thêm ID\n/list - Xem danh sách\n/status - Kiểm tra trạng thái\n/remove <id> - Xóa ID\n/check <id> - Kiểm tra 1 ID cụ thể`;
        await sendTelegramMessage(chatId, help);
        return true;
    }
    
    if (cmd === '/status') {
        await sendTelegramMessage(chatId, "🔄 Đang kiểm tra...");
        const testId = "4";
        const status = await checkWithRetry(testId);
        await sendTelegramMessage(chatId, `📊 *KẾT QUẢ*\nID: ${testId}\nTrạng thái: ${status}\n\nNếu ID '4' báo DIE, có thể Facebook đang chặn bot. Hãy thử ID khác.`);
        return true;
    }
    
    if (cmd.startsWith('/check ')) {
        const idToCheck = cmd.substring(7).trim();
        if (!idToCheck) return false;
        await sendTelegramMessage(chatId, `🔄 Đang kiểm tra ID: ${idToCheck}...`);
        const status = await checkWithRetry(idToCheck);
        await sendTelegramMessage(chatId, `📊 *KẾT QUẢ*\nID: ${idToCheck}\nTrạng thái: ${status}`);
        return true;
    }
    
    return false;
}

// === MAIN EXPORT ===
module.exports = async (req, res) => {
    // Xử lý Telegram webhook
    if (req.method === 'POST' && req.body?.message) {
        const chatId = req.body.message.chat.id;
        const text = req.body.message.text;
        await handleCommand(text, chatId);
        return res.status(200).json({ ok: true });
    }
    
    // Xử lý cron job
    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${CRON_SECRET}`) {
        return res.status(200).json({ 
            status: "ok", 
            message: "Monitor is running",
            time: new Date().toISOString()
        });
    }
    
    return res.status(200).json({ message: "Facebook Monitor Bot is running!" });
};
