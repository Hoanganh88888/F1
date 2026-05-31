const axios = require('axios');

// === CẤU HÌNH ===
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FB_IDS = (process.env.FB_IDS || "").split(",").map(id => id.trim()).filter(id => id);
const CRON_SECRET = process.env.CRON_SECRET || "default-secret-change-me";

// === DỮ LIỆU (lưu tạm trong RAM) ===
let fbData = {};

// === HÀM GỬI TELEGRAM ===
async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ Chưa cấu hình BOT_TOKEN hoặc CHAT_ID");
    return false;
  }
  
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const data = { 
    chat_id: CHAT_ID, 
    text: message,
    parse_mode: "Markdown"
  };
  
  try {
    const response = await axios.post(url, data);
    console.log("✅ Đã gửi Telegram");
    return true;
  } catch (error) {
    console.error("❌ Lỗi gửi Telegram:", error.message);
    return false;
  }
}

// === CHECK STATUS FACEBOOK ===
async function checkFbStatus(userId) {
  const url = `https://www.facebook.com/${userId}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10)'
  };
  
  try {
    const response = await axios.get(url, { 
      headers, 
      timeout: 10000,
      maxRedirects: 5
    });
    
    const text = response.data.toLowerCase();
    
    if (text.includes("disabled") || text.includes("vô hiệu")) {
      return "DIE";
    } else if (text.includes("not found") || text.includes("không tìm thấy")) {
      return "DIE";
    } else if (response.status === 200) {
      return "LIVE";
    }
    return "UNKNOWN";
    
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return "DIE";
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
  
  if (days > 0) {
    return `${days} ngày ${hours} giờ ${minutes} phút`;
  } else if (hours > 0) {
    return `${hours} giờ ${minutes} phút`;
  } else {
    return `${minutes} phút`;
  }
}

// === LOAD DATA ===
async function loadData() {
  return fbData;
}

async function saveData(data) {
  fbData = data;
}

// === KHỞI TẠO DỮ LIỆU ===
async function initData() {
  let data = await loadData();
  let changed = false;
  
  for (const fbId of FB_IDS) {
    if (!data[fbId]) {
      const currentStatus = await checkFbStatus(fbId);
      data[fbId] = {
        status: currentStatus,
        start_time: Math.floor(Date.now() / 1000),
        last_check: Math.floor(Date.now() / 1000)
      };
      console.log(`📋 ${fbId}: ${currentStatus}`);
      changed = true;
    }
  }
  
  if (changed) {
    await saveData(data);
  }
  return data;
}

// === MAIN MONITOR ===
async function monitor() {
  console.log("=".repeat(60));
  console.log(`🚀 Bot theo dõi Facebook bắt đầu! ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  
  if (!FB_IDS.length) {
    console.error("❌ Chưa cấu hình FB_IDS");
    return { success: false, error: "No FB IDs configured" };
  }
  
  let data = await initData();
  let changes = [];
  
  for (let i = 0; i < FB_IDS.length; i++) {
    const fbId = FB_IDS[i];
    console.log(`🔍 [${i+1}/${FB_IDS.length}] Đang kiểm tra: ${fbId}`);
    
    const currentStatus = await checkFbStatus(fbId);
    const previousStatus = data[fbId]?.status;
    const startTime = data[fbId]?.start_time || Math.floor(Date.now() / 1000);
    
    const duration = Math.floor(Date.now() / 1000) - startTime;
    
    if (currentStatus !== previousStatus && previousStatus) {
      let msg = "";
      
      if (previousStatus === "LIVE" && currentStatus === "DIE") {
        msg = `⚠️ *CẢNH BÁO!*\n\n`;
        msg += `Facebook: *${fbId}*\n`;
        msg += `Trạng thái: ✅ LIVE → ❌ DIE\n`;
        msg += `Thời gian Live: ${formatDuration(duration)}\n`;
        msg += `Thời gian: ${new Date().toLocaleString('vi-VN')}`;
        
        console.log(msg);
        await sendTelegram(msg);
        changes.push({ id: fbId, from: previousStatus, to: currentStatus, type: "die" });
        
      } else if (previousStatus === "DIE" && currentStatus === "LIVE") {
        msg = `✅ *PHỤC HỒI!*\n\n`;
        msg += `Facebook: *${fbId}*\n`;
        msg += `Trạng thái: ❌ DIE → ✅ LIVE\n`;
        msg += `Thời gian Die: ${formatDuration(duration)}\n`;
        msg += `Thời gian: ${new Date().toLocaleString('vi-VN')}`;
        
        console.log(msg);
        await sendTelegram(msg);
        changes.push({ id: fbId, from: previousStatus, to: currentStatus, type: "recover" });
      }
      
      data[fbId] = {
        status: currentStatus,
        start_time: Math.floor(Date.now() / 1000),
        last_check: Math.floor(Date.now() / 1000)
      };
      
    } else if (data[fbId]) {
      data[fbId].last_check = Math.floor(Date.now() / 1000);
    } else {
      data[fbId] = {
        status: currentStatus,
        start_time: Math.floor(Date.now() / 1000),
        last_check: Math.floor(Date.now() / 1000)
      };
    }
    
    await saveData(data);
    
    if (i < FB_IDS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  
  const liveCount = Object.values(data).filter(d => d.status === "LIVE").length;
  const dieCount = Object.values(data).filter(d => d.status === "DIE").length;
  const errorCount = Object.values(data).filter(d => d.status === "ERROR").length;
  
  const summary = `📊 *BÁO CÁO*\n✅ LIVE: ${liveCount}\n❌ DIE: ${dieCount}\n⚠️ ERROR: ${errorCount}\n🔄 Thay đổi: ${changes.length}`;
  console.log(summary);
  
  if (changes.length > 0) {
    await sendTelegram(summary);
  }
  
  return {
    success: true,
    total: FB_IDS.length,
    live: liveCount,
    die: dieCount,
    error: errorCount,
    changes: changes.length,
    timestamp: new Date().toISOString()
  };
}

// === EXPORT CHO VERCEL ===
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  
  if (authHeader !== expectedAuth) {
    console.warn(`⚠️ Unauthorized access`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  try {
    const result = await monitor();
    res.status(200).json(result);
  } catch (error) {
    console.error("❌ Lỗi:", error);
    await sendTelegram(`💀 *LỖI NGHIÊM TRỌNG*\n\`${error.message}\``);
    res.status(500).json({ error: error.message });
  }
};

if (require.main === module) {
  monitor().then(result => {
    console.log("\n📦 Kết quả:", JSON.stringify(result, null, 2));
  }).catch(err => {
    console.error("Lỗi:", err);
  });
}
