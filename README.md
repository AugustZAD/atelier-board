# Atelier Board

移动端优先的服装图集生成器。用户可从手机相册选择最多 50 张商品截图，使用“保留白底”快速模式或 Modal L4 上的 BiRefNet Lite 抠图，再生成可直接转发的双列瀑布流网址。

## 架构

- **GitHub Pages**：静态手机端界面，上传前自动去除商品截图下方 UI，并将最长边压缩至 1280px。
- **保留白底（默认）**：不修改衣服或背景像素，只在浏览器中裁掉商品四周的多余空白并压缩图片，不启动 GPU。
- **Cloudflare Worker + KV**：任务鉴权、图片临时存储、进度查询和分享页。AI 模式的原图成功处理后立即删除，失败任务的原图最多保留 24 小时。
- **Modal L4**：运行固定版本的 MIT 许可 BiRefNet Lite。一个任务内部使用 batch 2，最多横向扩展到 2 个容器。
- **分享页**：处理结果保存 31 天，分享清单保存 30 天；分享网址到期后自动失效。

Cloudflare 与 Modal 使用服务端密钥通信。密钥不进入仓库或浏览器代码。

## 实测性能

在 Modal L4 上用 30 张 1024×1024 输入测试：

| Batch | 纯推理时间 | 吞吐 | 显存峰值（reserved） |
| ---: | ---: | ---: | ---: |
| 1 | 2.63 s | 11.41 张/s | 1.41 GiB |
| 2 | 2.45 s | 12.26 张/s | 2.71 GiB |
| 4 | 2.55 s | 11.76 张/s | 5.28 GiB |
| 8 | 2.71 s | 11.09 张/s | 10.42 GiB |

因此生产配置采用 batch 2。开启 Modal CPU 内存快照后，完整 benchmark 的缩容后启动时间由首次约 47.1 秒降至约 11.4 秒；其中四组推理本身合计约 10.3 秒。

## 本地检查

```bash
python3 -m http.server 4173
npm run check
npx wrangler deploy --dry-run
```

## 部署

```bash
MODAL_DISABLE_API_PROXY=1 uvx modal deploy modal_app.py --profile s98081096
npx wrangler types
npx wrangler deploy --minify
git push origin main
```

Worker 配置见 `wrangler.jsonc`；Modal 服务见 `modal_app.py`。
