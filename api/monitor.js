const axios = require('axios');

// === CẤU HÌNH ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // ID admin nhận báo cáo
const CRON_SECRET = process.env.CRON_SECRET || "default-secret-change-me";

// === KẾT NỐI REDIS (nếu có) ===
let redis = null;
let USE_REDIS = false;

// Thử kết nối Redis nếu có cấu hình
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redis = Redis.fromEnv();
    USE_REDIS = true;
    console.log("✅ Đã kết nối Redis");
} else {
    console.log("⚠️ Không dùng Redis, dữ liệu sẽ mất khi restart");
}

// === DỮ LIỆU TẠM (fallback khi không có Redis) ===
let memoryWatchList = [];
let memoryFbData = {};

// === LẤY DANH SÁCH ID CẦN THEO DÕI ===
async function getWatchList() {
    // Ưu tiên lấy từ Redis nếu có
    if (USE_REDIS && redis) {
        try {
            let ids = await redis.get('fb_watchlist');
            if (ids && Array.isArray(ids) && ids.length > 0) {
                return ids;
            }
        } catch (err) {
            console.error("Lỗi đọc Redis:", err.message);
        }
    }
    
    // Fallback: dùng memory
    if (memoryWatchList.length > 0) {
        return memoryWatchList;
    }
    
    // Fallback cuối: dùng từ environment variable
    const envIds = (process.env.FB_IDS || "").split(",").map(id => id.trim()).filter(id => id);
    if (envIds.length > 0) {
        memoryWatchList = envIds;
        return envIds;
    }
    
    return [];
}

// === LƯU DANH SÁCH ID ===
async function saveWatchList(ids) {
    if (USE_REDIS && redis) {
        try {
            await redis.set('fb_watchlist', ids);
            console.log("✅ Đã lưu danh sách vào Redis");
        } catch (err) {
            console.error("Lỗi lưu Redis:", err.message);
        }
    }
    memoryWatchList = [...ids];
}

// === LOAD DATA TRẠNG THÁI FB ===
async function loadFbData() {
    if (USE_REDIS && redis) {
        try {
            const data = await redis.get('fb_data');
            if (data) return data;
        } catch (err) {
            console.error("Lỗi đọc fb_data từ Redis:", err.message);
        }
    }
    return memoryFbData;
}

async function saveFbData(data) {
    if (USE_REDIS && redis) {
        try {
            await redis.set('fb_data', data);
        } catch (err) {
            console.error("Lỗi lưu fb_data vào Redis:", err.message);
        }
    }
    memoryFbData = data;
}

// === HÀM GỬI TIN NHẮN TELEGRAM ===
async function sendTelegramMessage(chatId, message, parseMode = "Markdown") {
    if (!BOT_TOKEN) {
        console.log("⚠️ Chưa cấu hình BOT_TOKEN");
        return false;
    }
    
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const data = { 
        chat_id: chatId, 
        text: message, 
        parse_mode: parseMode,
        disable_web_page_preview: true
    };
    
    try {
        await axios.post(url, data);
        console.log("✅ Đã gửi Telegram:", message.substring(0, 50));
        return true;
    } catch (error) {
        console.error("❌ Lỗi gửi Telegram:", error.message);
        return false;
    }
}

// === GỬI TIN NHẮN ĐẾN ADMIN ===
async function sendToAdmin(message) {
    if (ADMIN_CHAT_ID) {
        await sendTelegramMessage(ADMIN_CHAT_ID, message);
    }
}

// === CHECK STATUS FACEBOOK ===
async function checkFbStatus(userId) {
    const url = `https://www.facebook.com/${userId}`;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    };
    
    try {
        const response = await axios.get(url, { 
            headers, 
            timeout: 15000,
            maxRedirects: 5
        });
        
        const text = response.data.toLowerCase();
        
        // Các dấu hiệu DIE
        const dieKeywords = [
            "disabled", "vô hiệu", "temporarily locked", "bị khóa",
            "not found", "không tìm thấy", "content isn't available",
            "sorry, this page isn't available", "this content isn't available",
            "profile is not available", "user not found", "page doesn't exist"
        ];
        
        for (const keyword of dieKeywords) {
            if (text.includes(keyword)) {
                return "DIE";
            }
        }
        
        if (response.status === 200) {
            return "LIVE";
        }
        return "UNKNOWN";
        
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return "DIE";
        }
        if (error.response && error.response.status === 403) {
            return "LIVE";
        }
        console.error(`Lỗi check ${userId}:`, error.message);
        return "ERROR";
    }
}

// === TÍNH THỜI GIAN ===
function formatDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (days > 0) {
        return `${days} ngày ${hours} giờ ${minutes} phút`;
    } else if (hours > 0) {
        return `${hours} giờ ${minutes} phút ${secs} giây`;
    } else if (minutes > 0) {
        return `${minutes} phút ${secs} giây`;
    } else {
        return `${secs} giây`;
    }
}

// === KHỞI TẠO DỮ LIỆU CHO ID MỚI ===
async function initDataForNewIds(ids, data) {
    let changed = false;
    
    for (const fbId of ids) {
        if (!data[fbId]) {
            const currentStatus = await checkFbStatus(fbId);
            data[fbId] = {
                status: currentStatus,
                start_time: Math.floor(Date.now() / 1000),
                last_check: Math.floor(Date.now() / 1000)
            };
            console.log(`📋 ID mới ${fbId}: ${currentStatus}`);
            changed = true;
        }
    }
    
    if (changed) {
        await saveFbData(data);
    }
    return data;
}

// === XÓA DỮ LIỆU CỦA ID ĐÃ XÓA ===
async function cleanupRemovedIds(currentIds, data) {
    let changed = false;
    
    for (const existingId in data) {
        if (!currentIds.includes(existingId)) {
            delete data[existingId];
            changed = true;
            console.log(`🗑️ Đã xóa dữ liệu của ID: ${existingId}`);
        }
    }
    
    if (changed) {
        await saveFbData(data);
    }
    return data;
}

// === HÀM MONITOR CHÍNH ===
async function monitor() {
    console.log("=".repeat(60));
    console.log(`🚀 BẮT ĐẦU MONITOR: ${new Date().toISOString()}`);
    console.log("=".repeat(60));
    
    // Lấy danh sách ID cần theo dõi
    const watchList = await getWatchList();
    
    if (!watchList.length) {
        console.log("📭 Danh sách theo dõi trống");
        return { success: true, message: "No IDs to monitor", total: 0 };
    }
    
    console.log(`📋 Số ID cần theo dõi: ${watchList.length}`);
    
    // Load dữ liệu hiện tại
    let fbDataObj = await loadFbData();
    
    // Xóa dữ liệu của ID đã bị xóa khỏi danh sách
    fbDataObj = await cleanupRemovedIds(watchList, fbDataObj);
    
    // Khởi tạo dữ liệu cho ID mới
    fbDataObj = await initDataForNewIds(watchList, fbDataObj);
    
    let changes = [];
    let results = [];
    
    // Kiểm tra từng ID
    for (let i = 0; i < watchList.length; i++) {
        const fbId = watchList[i];
        console.log(`🔍 [${i+1}/${watchList.length}] Đang kiểm tra: ${fbId}`);
        
        const currentStatus = await checkFbStatus(fbId);
        const previousData = fbDataObj[fbId];
        const previousStatus = previousData?.status;
        const startTime = previousData?.start_time || Math.floor(Date.now() / 1000);
        
        const duration = Math.floor(Date.now() / 1000) - startTime;
        results.push({ id: fbId, status: currentStatus, previous: previousStatus });
        
        // === PHÁT HIỆN THAY ĐỔI ===
        if (previousStatus && currentStatus !== previousStatus) {
            let msg = "";
            let isImportant = false;
            
            if (previousStatus === "LIVE" && currentStatus === "DIE") {
                msg = `⚠️ *CẢNH BÁO! TÀI KHOẢN BỊ DIE*\n\n`;
                msg += `📌 *ID:* \`${fbId}\`\n`;
                msg += `📊 *Trạng thái:* ✅ LIVE → ❌ DIE\n`;
                msg += `⏱️ *Thời gian LIVE:* ${formatDuration(duration)}\n`;
                msg += `🕐 *Thời gian:* ${new Date().toLocaleString('vi-VN')}`;
                isImportant = true;
                
            } else if (previousStatus === "DIE" && currentStatus === "LIVE") {
                msg = `✅ *PHỤC HỒI! TÀI KHOẢN LIVE LẠI*\n\n`;
                msg += `📌 *ID:* \`${fbId}\`\n`;
                msg += `📊 *Trạng thái:* ❌ DIE → ✅ LIVE\n`;
                msg += `⏱️ *Thời gian DIE:* ${formatDuration(duration)}\n`;
                msg += `🕐 *Thời gian:* ${new Date().toLocaleString('vi-VN')}`;
                isImportant = true;
            }
            
            if (isImportant) {
                console.log(msg);
                await sendToAdmin(msg);
                changes.push({ id: fbId, from: previousStatus, to: currentStatus });
            }
            
            // Cập nhật trạng thái mới
            fbDataObj[fbId] = {
                status: currentStatus,
                start_time: Math.floor(Date.now() / 1000),
                last_check: Math.floor(Date.now() / 1000)
            };
            
        } else if (fbDataObj[fbId]) {
            // Cập nhật thời gian check cuối
            fbDataObj[fbId].last_check = Math.floor(Date.now() / 1000);
        }
        
        await saveFbData(fbDataObj);
        
        // Delay giữa các request
        if (i < watchList.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    // Thống kê
    const liveCount = results.filter(r => r.status === "LIVE").length;
    const dieCount = results.filter(r => r.status === "DIE").length;
    const errorCount = results.filter(r => r.status === "ERROR").length;
    
    const summary = `📊 *BÁO CÁO MONITOR* ${new Date().toLocaleString('vi-VN')}\n\n` +
        `📋 *Tổng số:* ${watchList.length}\n` +
        `✅ *LIVE:* ${liveCount}\n` +
        `❌ *DIE:* ${dieCount}\n` +
        `⚠️ *ERROR:* ${errorCount}\n` +
        `🔄 *Thay đổi:* ${changes.length}`;
    
    console.log(summary.replace(/\*/g, ''));
    
    // Gửi báo cáo nếu có thay đổi hoặc mỗi 10 lần
    if (changes.length > 0) {
        await sendToAdmin(summary);
    } else if (Math.random() < 0.05) {
        await sendToAdmin(`🟢 *HỆ THỐNG HOẠT ĐỘNG TỐT*\n${summary}`);
    }
    
    return {
        success: true,
        total: watchList.length,
        live: liveCount,
        die: dieCount,
        error: errorCount,
        changes: changes.length,
        results: results,
        timestamp: new Date().toISOString()
    };
}

// === XỬ LÝ LỆNH TELEGRAM ===
async function handleTelegramCommand(messageText, chatId) {
    const command = messageText.trim().toLowerCase();
    const originalCommand = messageText.trim();
    
    // === LỆNH /START ===
    if (command === '/start') {
        const helpMsg = `🤖 *FACEBOOK MONITOR BOT*\n\n` +
            `🔍 Theo dõi trạng thái Facebook và gửi thông báo khi có thay đổi\n\n` +
            `📋 *DANH SÁCH LỆNH:*\n` +
            `/start - Hiển thị hướng dẫn\n` +
            `/list - Xem danh sách ID đang theo dõi\n` +
            `/status - Kiểm tra trạng thái tất cả ID\n` +
            `/add <id> - Thêm ID mới (ví dụ: /add 1000123456)\n` +
            `/remove <id> - Xóa ID khỏi danh sách\n` +
            `/help - Hiển thị hướng dẫn chi tiết`;
        
        await sendTelegramMessage(chatId, helpMsg);
        return true;
    }
    
    // === LỆNH /HELP ===
    if (command === '/help') {
        const helpMsg = `📖 *HƯỚNG DẪN CHI TIẾT*\n\n` +
            `🔹 *Thêm ID:*\n/add 1000123456\n/add username\n/add profile.php?id=12345\n\n` +
            `🔹 *Xóa ID:*\n/remove 1000123456\n\n` +
            `🔹 *Xem danh sách:*\n/list\n\n` +
            `🔹 *Kiểm tra trạng thái:*\n/status\n\n` +
            `💡 *Lưu ý:*\n- ID có thể là số hoặc username\n- Bot sẽ tự động thông báo khi có thay đổi\n- Dữ liệu được lưu trên Redis (nếu có)`;
        
        await sendTelegramMessage(chatId, helpMsg);
        return true;
    }
    
    // === LỆNH /LIST ===
    if (command === '/list') {
        const ids = await getWatchList();
        
        if (ids.length === 0) {
            await sendTelegramMessage(chatId, "📭 *DANH SÁCH TRỐNG*\n\nDùng /add <id> để thêm ID cần theo dõi");
        } else {
            let msg = "*📋 DANH SÁCH THEO DÕI*\n\n";
            for (let i = 0; i < ids.length; i++) {
                msg += `${i+1}. \`${ids[i]}\`\n`;
            }
            msg += `\n📊 *Tổng số:* ${ids.length} ID`;
            await sendTelegramMessage(chatId, msg);
        }
        return true;
    }
    
    // === LỆNH /STATUS ===
    if (command === '/status') {
        const ids = await getWatchList();
        
        if (ids.length === 0) {
            await sendTelegramMessage(chatId, "📭 Chưa có ID nào để kiểm tra.\nDùng /add <id> để thêm.");
            return true;
        }
        
        await sendTelegramMessage(chatId, "🔄 *Đang kiểm tra trạng thái...* Vui lòng chờ...");
        
        let msg = "*🔍 TRẠNG THÁI HIỆN TẠI*\n\n";
        
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const status = await checkFbStatus(id);
            const emoji = status === 'LIVE' ? '✅' : (status === 'DIE' ? '❌' : '⚠️');
            msg += `${emoji} \`${id}\`: ${status}\n`;
            
            if (i < ids.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        await sendTelegramMessage(chatId, msg);
        return true;
    }
    
    // === LỆNH /ADD ===
    if (originalCommand.startsWith('/add ')) {
        const newId = originalCommand.substring(5).trim();
        
        if (!newId) {
            await sendTelegramMessage(chatId, "⚠️ *CÚ PHÁP:* /add <facebook_id>\n\nVí dụ:\n/add 1000123456\n/add hoanganh\n/add profile.php?id=12345");
            return true;
        }
        
        // Kiểm tra ID hợp lệ (không chứa ký tự đặc biệt nguy hiểm)
        if (newId.length > 100 || /[<>\"\'\\]/.test(newId)) {
            await sendTelegramMessage(chatId, "❌ *ID không hợp lệ!*\nID chỉ chứa chữ cái, số, dấu chấm, gạch dưới hoặc gạch ngang.");
            return true;
        }
        
        let currentIds = await getWatchList();
        
        if (currentIds.includes(newId)) {
            await sendTelegramMessage(chatId, `⚠️ *ID đã tồn tại!*\n\`${newId}\` đã có trong danh sách theo dõi.\n\nDùng /list để xem danh sách.`);
            return true;
        }
        
        // Thêm ID mới
        currentIds.push(newId);
        await saveWatchList(currentIds);
        
        // Kiểm tra trạng thái ID mới
        const status = await checkFbStatus(newId);
        const statusEmoji = status === 'LIVE' ? '✅ LIVE' : (status === 'DIE' ? '❌ DIE' : '⚠️ UNKNOWN');
        
        const msg = `✅ *ĐÃ THÊM ID MỚI*\n\n` +
            `📌 *ID:* \`${newId}\`\n` +
            `📊 *Trạng thái:* ${statusEmoji}\n` +
            `📋 *Tổng số ID:* ${currentIds.length}`;
        
        await sendTelegramMessage(chatId, msg);
        
        // Thông báo cho admin
        await sendToAdmin(`📢 *NGƯỜI DÙNG ĐÃ THÊM ID*\n👤 Chat: ${chatId}\n📌 ID: \`${newId}\``);
        
        return true;
    }
    
    // === LỆNH /REMOVE ===
    if (originalCommand.startsWith('/remove ')) {
        const removeId = originalCommand.substring(8).trim();
        
        if (!removeId) {
            await sendTelegramMessage(chatId, "⚠️ *CÚ PHÁP:* /remove <facebook_id>\n\nDùng /list để xem danh sách ID.");
            return true;
        }
        
        let currentIds = await getWatchList();
        
        if (!currentIds.includes(removeId)) {
            await sendTelegramMessage(chatId, `⚠️ *Không tìm thấy ID!*\n\`${removeId}\` không có trong danh sách theo dõi.\n\nDùng /list để xem danh sách.`);
            return true;
        }
        
        // Xóa ID
        const newIds = currentIds.filter(id => id !== removeId);
        await saveWatchList(newIds);
        
        const msg = `🗑️ *ĐÃ XÓA ID*\n\n` +
            `📌 *ID:* \`${removeId}\`\n` +
            `📋 *Còn lại:* ${newIds.length} ID`;
        
        await sendTelegramMessage(chatId, msg);
        
        return true;
    }
    
    // Lệnh không xác định
    if (command.startsWith('/')) {
        await sendTelegramMessage(chatId, `⚠️ *Lệnh không xác định:* \`${command}\`\n\nDùng /help để xem danh sách lệnh.`);
        return true;
    }
    
    return false;
}

// === WEBHOOK TELEGRAM ===
async function handleTelegramWebhook(body) {
    if (!body.message) return false;
    
    const chatId = body.message.chat.id;
    const messageText = body.message.text;
    const from = body.message.from;
    
    console.log(`📩 Nhận tin nhắn từ @${from?.username || from?.first_name}: ${messageText}`);
    
    if (messageText && messageText.startsWith('/')) {
        return await handleTelegramCommand(messageText, chatId);
    }
    
    return false;
}

// === EXPORT CHO VERCEL ===
module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // === TELEGRAM WEBHOOK (xử lý lệnh từ bot) ===
    if (req.method === 'POST') {
        // Kiểm tra có phải webhook từ Telegram không
        if (req.body && req.body.message) {
            try {
                await handleTelegramWebhook(req.body);
                return res.status(200).json({ ok: true });
            } catch (error) {
                console.error("Lỗi xử lý webhook:", error);
                return res.status(500).json({ error: error.message });
            }
        }
        
        // Có thể là request từ cron-job (có auth)
        const authHeader = req.headers.authorization;
        const expectedAuth = `Bearer ${CRON_SECRET}`;
        
        if (authHeader === expectedAuth) {
            try {
                const result = await monitor();
                return res.status(200).json(result);
            } catch (error) {
                console.error("Lỗi monitor:", error);
                return res.status(500).json({ error: error.message });
            }
        }
        
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    // === GET REQUEST (kiểm tra status) ===
    if (req.method === 'GET') {
        const authHeader = req.headers.authorization;
        const expectedAuth = `Bearer ${CRON_SECRET}`;
        
        if (authHeader === expectedAuth) {
            try {
                const watchList = await getWatchList();
                return res.status(200).json({
                    status: "running",
                    total_ids: watchList.length,
                    ids: watchList,
                    redis_enabled: USE_REDIS,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
        }
        
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    return res.status(405).json({ error: "Method not allowed" });
};

// Chạy trực tiếp khi test
if (require.main === module) {
    console.log("🧪 Chạy test mode...");
    monitor().then(result => {
        console.log("\n📦 Kết quả:", JSON.stringify(result, null, 2));
    }).catch(err => {
        console.error("Lỗi:", err);
    });
}
