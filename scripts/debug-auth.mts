import { tc3Authorization } from "../src/lib/ai/tencent-soe";

const auth = tc3Authorization({
  secretId: "AKIDTEST",
  secretKey: "KEYTEST",
  host: "asr.tencentcloudapi.com",
  service: "asr",
  region: "ap-shanghai",
  action: "CreateRecTask",
  timestamp: 1700000000,
  body: "{}",
});
console.log(auth);
process.exit(0);
