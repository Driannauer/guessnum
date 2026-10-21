# 数字炸弹

中文猜四位数网页小游戏。支持前导零、重复数字、单机练习和双人实时联机。电脑端左侧为“数字炸弹”标题、输入和数字键盘，右侧为记录与数字排除表盘。手机、平板使用竖屏，从上到下依次为猜测记录、数字标记表盘、四位输入框和数字键盘，横屏提示旋转；旋转时保留输入、固定数字与排除标记。两端记录均为并排两联，每联固定 8 行，16 次猜测全部在一屏内显示。

## 玩法

- 输入由 `0–9` 组成的四位数字，例如 `0012` 或 `8888`。
- 右上角设置齿轮中可切换单机／联机、输入六位房间号加入、创建房间及查看玩法说明。单机的新开一局和揭晓答案也在设置内。邀请链接会自动打开设置并填好房间号。
- **数字对的个数**：猜中的数字总数，包含位置正确的数字；重复数字按出现次数匹配。
- **位置对的个数**：数字与位置同时正确的个数。位置对 4 个即获胜。
- 例如：答案 `0012`、猜测 `0001`，数字对 3 个、位置对 2 个。
- 每次猜测为一行三列：猜的数字、数字对的个数、位置对的个数。左右两联分别显示第 1–8 次和第 9–16 次猜测，每联从底部追加，最新结果在该联最下方，之前的结果向上推。
- 点击任意输入格，可指定输入、替换或删除这一位，其他位置不移动。支持键盘左右键切换位置、数字键输入、Backspace/Delete 删除选中位、Enter 提交。也可粘贴完整数字。
- 手机、平板长按输入格，或电脑右键输入格，可以固定其中的数字。固定后显示锁图标，提交后保留到下一次猜测，并跳过这格输入；再次长按或右键可解除固定。
- 0–9 表盘单击切换排除，快速双击切换“✓”；打勾和排除互斥。手机、平板长按数字，或电脑右键数字，可选择蓝、黄两种填充色，也可清除颜色；颜色可与打勾或排除独立组合。旧的灰色和红色填充会自动清除。这些标记是个人推理笔记，不影响实际猜测判定。
- 固定位置、排除、打勾和颜色在同一浏览器刷新后保留，单机与联机分别保存，开始新局时清空。记录不分页、不滚动，始终显示固定两联各 8 行；游戏页面本身也不滚动。
- 单机答案由服务器使用加密随机数生成，提交猜测时需要网络，无需保持联机长连接。最多猜 16 次，仍未猜中则挑战失败并显示答案；第 16 次猜中仍判胜。支持揭晓答案和重新开局。
- 对弈由房主创建六位房间码，通过房间码或邀请链接加入。双方锁定数字后自动开始，轮流猜测，房主先手，先猜中者获胜。双方各有 16 次机会；先手第 16 次未猜中后，后手仍可完成最后一次猜测，双方均未中则流局。第 16 次猜中仍判胜，流局也可以再战。双方同意再战后交换先手。
- 对弈中离开房间视为认输；关闭页面或断网会保留游戏，使用同一浏览器重新进入可继续。只有前台联机房间保持实时连接；短暂断线自动重连，持续 6 秒未恢复才提示，切换单机或转入后台不弹断线提示。
- 同一浏览器通过 HttpOnly Cookie 恢复身份。两名玩家应使用不同设备、浏览器或独立隐私窗口。普通的两个标签页会同步同一个玩家。
- 房间在最后一次游戏操作 24 小时后过期；浏览器身份在最后使用 30 天后清理。单机保留当前一局记录，对弈保留当前局双方记录。

## 本地运行

需要 Node.js 24 或更高版本。

```sh
npm ci
npm start
```

打开 http://127.0.0.1:4186 。可用环境变量 `PORT`、`DATA_DIR` 配置端口和 SQLite 数据目录。服务只监听 `127.0.0.1`，由 Nginx 对外提供访问。

默认仅允许同源页面通过 iframe 嵌入。需要允许其他站点时，可通过环境变量 `FRAME_ANCESTORS` 配置 CSP 来源，例如 `FRAME_ANCESTORS="'self' https://portal.example.com" npm start`。

## 验证

```sh
npm test
npx playwright install chromium
npm run test:browser
```

测试覆盖重复数字与全部一万种猜测、服务端保密、非法输入、双人回合与胜负、实时同步、服务重启后的恢复、16 次机会的失败／流局及最后一次猜中边界，以及真实浏览器双人完整流程、两联记录和手机竖屏布局。

## 部署

`deploy/` 包含 systemd 服务、Nginx HTTP/HTTPS 配置及应用安装脚本。部署前将两个 Nginx 配置和以下命令中的 `guessnum.example.com` 替换为自己的域名。以下命令以 root 执行，且 PATH 中的 `node` 必须为 Node.js 24+。

```sh
bash deploy/install.sh
install -m 0644 deploy/nginx-http.conf /etc/nginx/sites-available/guessnum.example.com
ln -s /etc/nginx/sites-available/guessnum.example.com /etc/nginx/sites-enabled/guessnum.example.com
install -d -m 0755 /var/www/letsencrypt
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/letsencrypt -d guessnum.example.com --non-interactive --agree-tos --register-unsafely-without-email
install -m 0644 deploy/nginx.conf /etc/nginx/sites-available/guessnum.example.com
nginx -t && systemctl reload nginx
```

应用代码在 `/var/www/guessnum`，独立 Node.js 运行时在 `/opt/guessnum/node`，游戏数据库在 `/var/lib/guessnum/guessnum.sqlite`。以 `www-data` 运行，启用系统启动和故障自动重启，SQLite 数据目录独立于代码。Nginx 对 `/ws` 支持 WebSocket 升级，并将 HTTP 重定向到 HTTPS。

服务器按脚本、样式内容生成带哈希的资源地址，页面不缓存，避免 CDN 或浏览器中之前版本的缓存造成页面与脚本不匹配。

后续更新执行 `bash deploy/install.sh` 即可，数据库保留。不要在已有 HTTPS 的站点重新安装临时 HTTP 配置。

```sh
systemctl status guessnum
journalctl -u guessnum -n 50 --no-pager
curl -fsS https://guessnum.example.com/health
```

证书可通过系统 `certbot.timer` 自动续期。部署时需在 `/etc/letsencrypt/renewal-hooks/deploy/` 配置续期钩子，续期成功后执行 `nginx -t && systemctl reload nginx`。

## 数据备份

使用 SQLite 在线备份接口获取一致备份（不要只复制正在写入的数据库主文件）。

```sh
umask 077
install -d -m 0700 /var/backups/guessnum
/opt/guessnum/node --input-type=module -e 'import { DatabaseSync, backup } from "node:sqlite"; const db = new DatabaseSync("/var/lib/guessnum/guessnum.sqlite"); await backup(db, "/var/backups/guessnum/guessnum.sqlite"); db.close();'
```

数据库含本局秘密数字和浏览器身份摘要，备份应仅供管理员访问。

## 提交文件

`node_modules/` 由 `npm ci` 生成，不需要提交。测试报告、截图、运行数据库、备份、`.env` 环境文件和常见密钥文件已加入 `.gitignore`；提交前仍应检查自定义文件中是否包含个人信息或凭据。
