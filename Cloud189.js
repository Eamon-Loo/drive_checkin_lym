require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const env = require("./env");

log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: {
      type: "console",
      layout: {
        type: "pattern",
        pattern: "\u001b[32m%d{yyyy-MM-dd hh:mm:ss}\u001b[0m - %m"
      }
    }
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } }
});

const logger = log4js.getLogger();

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const doTask = async (cloudClient) => {
  const result = [];
  
  // 个人空间签到部分：仅在第一个账号且 private_only_first 为 true 时执行单线程
  let getSpace = [`${firstSpace}签到个人云获得(M)`];
  if (privateThreadCount > 0) {  // 只有第一个账号会执行
    const signPromises1 = [];
    for (let m = 0; m < privateThreadCount; m++) {
      signPromises1.push((async () => {
        try {
          const res1 = await cloudClient.userSign();
          if (!res1.isSign) {
            getSpace.push(` ${res1.netdiskBonus}`);
          }
        } catch (e) {
          getSpace.push(` 0`);
        }
      })());
    }
    await Promise.all(signPromises1);
    if (getSpace.length == 1) getSpace.push(" 0");
    result.push(getSpace.join(" "));
  } else {
    getSpace.push(" 0");  // 其他账号不签个人空间
    result.push(getSpace.join(" "));
  }

  // 家庭空间签到部分：第一个账号单线程，其他账号并行
  const signPromises2 = [];
  getSpace = [`${firstSpace}签到家庭云获得(M)`];
  const { familyInfoResp } = await cloudClient.getFamilyList();

  if (familyInfoResp) {
    const family = familyInfoResp.find((f) => f.familyId == familyID) || familyInfoResp[0];
    result.push(`${firstSpace}开始签到家庭云 ID: ${family.familyId}`);

    for (let m = 0; m < familyThreadCount; m++) {
      signPromises2.push((async () => {
        try {
          const res = await cloudClient.familyUserSign(family.familyId);
          if (!res.signStatus) {
            getSpace.push(` ${res.bonusSpace}`);
          }
        } catch (e) {
          getSpace.push(` 0`);
        }
      })());
    }

    await Promise.all(signPromises2);
    if (getSpace.length == 1) getSpace.push(" 0");
    result.push(getSpace.join(" "));
  }

  return result;
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBotToken && telegramBotId)) {
    return;
  }
  const data = {
    chat_id: telegramBotId,
    text: `${title}\n\n${desp}`,
  };
  superagent
    .post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`)
    .send(data)
    .timeout(3000)
    .end((err, res) => {
      if (err) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (!json.ok) {
        logger.error(`TelegramBot推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("TelegramBot推送成功");
      }
    });
};

const pushWxPusher = (title, desp) => {
  if (!(WX_PUSHER_APP_TOKEN && WX_PUSHER_UID)) {
    return;
  }
  const data = {
    appToken: WX_PUSHER_APP_TOKEN,
    contentType: 1,
    summary: title,
    content: desp,
    uids: [WX_PUSHER_UID],
  };
  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(data)
    .timeout(3000)
    .end((err, res) => {
      if (err) {
        logger.error(`wxPusher推送失败:${JSON.stringify(err)}`);
        return;
      }
      const json = JSON.parse(res.text);
      if (json.data[0].code !== 1000) {
        logger.error(`wxPusher推送失败:${JSON.stringify(json)}`);
      } else {
        logger.info("wxPusher推送成功");
      }
    });
};

const push = (title, desp) => {
  pushWxPusher(title, desp);
  pushTelegramBot(title, desp);
};

let firstSpace = "  ";
let familyID;

let accounts = env.tyys;
let familyIDs = env.FAMILY_ID.split(/[\n ]/);

let WX_PUSHER_UID = env.WX_PUSHER_UID;
let WX_PUSHER_APP_TOKEN = env.WX_PUSHER_APP_TOKEN;

let telegramBotToken = env.TELEGRAM_BOT_TOKEN;
let telegramBotId = env.TELEGRAM_CHAT_ID;

let private_threadx = env.private_threadx; //进程数
let family_threadx = env.family_threadx; //进程数

let i = 0;

const main = async () => {
  accounts = accounts.split(/[\n ]/);

  let userName0, password0, familyCapacitySize;

  for (i = 0; i < accounts.length; i += 2) {
    let n = parseInt(i / 2 / 20);
    familyID = familyIDs[n];
    const [userName, password] = accounts.slice(i, i + 2);
    if (!userName || !password) continue;

    const userNameInfo = mask(userName, 3, 7);

    try {
      const cloudClient = new CloudClient(userName, password);

      logger.log(`${i / 2 + 1}.账户 ${userNameInfo} 开始执行`);
      await cloudClient.login();
      const { cloudCapacityInfo: cloudCapacityInfo0, familyCapacityInfo: familyCapacityInfo0 } = await cloudClient.getUserSizeInfo();
      const result = await doTask(cloudClient);
      
      if (i / 2 % 20 == 0) {
        userName0 = userName;
        password0 = password;
        familyCapacitySize = familyCapacityInfo0.totalSize;
      }
      const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
      result.forEach((r) => logger.log(r));

    } catch (e) {
      logger.error(e);
      if (e.code === "ETIMEDOUT") throw e;
    } finally {
      logger.log("");
    }

    if(i / 2 % 20 == 19 || i + 2 == accounts.length){
      if (!userName0 || !password0) continue;
      const cloudClient = new CloudClient(userName0, password0);
      await cloudClient.login();
      const userNameInfo = mask(userName0, 3, 7);
      const { familyCapacityInfo: finalfamilyCapacityInfo } = await cloudClient.getUserSizeInfo();
    
      const capacityChange = finalfamilyCapacityInfo.totalSize - familyCapacitySize;
      logger.log(`本次签到主号${userNameInfo} 家庭+ ${capacityChange / 1024 / 1024}M \n`);
      
      const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
      const personalTotalCapacity = (cloudCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2);  // 个人容量，单位 GB
      const familyTotalCapacity = (familyCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2);    // 家庭容量，单位 GB
      logger.log(`${firstSpace}主账号个人总容量：${personalTotalCapacity} GB`);
      logger.log(`${firstSpace}主账号家庭总容量：${familyTotalCapacity} GB`);
    }
  }
};

(async () => {
  try {
    await main();
  } finally {
    logger.log("\n\n");
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("lym天翼签到", content);
    recording.erase();
  }
})();
