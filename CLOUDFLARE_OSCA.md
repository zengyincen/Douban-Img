# 使用 Cloudflare Workers + OSCA 高校云存储部署 Dover

这个版本使用 Cloudflare Worker 处理请求，使用 OSCA 的 S3 兼容接口缓存豆瓣封面。

## 部署前准备

在 OSCA 控制台取得以下信息：

- Endpoint（文件网关地址）
- Bucket 名称
- AccessKey（AK）
- SecretKey（SK）

OSCA 官方示例使用 `us-east-1`，并要求 S3 path-style。代码已经按这两项配置。

## 配置并部署

1. `wrangler.jsonc` 已配置 Endpoint `https://fgws3-ocloud.ihep.ac.cn` 和 Bucket `21483-dbimg`。
2. 安装依赖：`npm install`。
3. 登录 Cloudflare：`npx wrangler login`。
4. 通过交互式输入保存密钥，密钥不会写入仓库：

   ```sh
   npx wrangler secret put OSCA_ACCESS_KEY_ID
   npx wrangler secret put OSCA_SECRET_ACCESS_KEY
   ```

5. 检查配置：`npm run deploy:check`。
6. 部署：`npm run deploy`。

本地开发时复制 `.dev.vars.example` 为 `.dev.vars`，填入本地密钥，然后执行 `npm run dev`。

## 测试

Worker 的自定义域名为 `https://dbimg.imnotfound.eu.org`：

```text
https://dbimg.imnotfound.eu.org/movie/35337634.jpg
https://dbimg.imnotfound.eu.org/book/36093928.jpg
https://dbimg.imnotfound.eu.org/music/24840163.jpg
https://dbimg.imnotfound.eu.org/game/26815212.jpg
https://dbimg.imnotfound.eu.org/celebrity/1041028.jpg
```

响应头 `x-dover-cache: MISS` 表示从豆瓣获取并写入 OSCA；再次访问应为 `x-dover-cache: HIT`。

## 安全说明

- 不要把 AK、SK 写入 `wrangler.jsonc`、`.dev.vars.example` 或 GitHub。
- Worker 强制要求 OSCA Endpoint 使用 HTTPS。
- 接口是公开的，建议在 Cloudflare 控制台配置速率限制和用量告警。
