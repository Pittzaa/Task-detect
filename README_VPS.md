# คู่มือ host บน VPS (แทน Vercel + Neon)

คู่มือนี้ใช้เซิร์ฟเวอร์ของคุณเอง (VPS) รันทุกอย่างในเครื่องเดียว: **PostgreSQL + แอป (Node.js) + Caddy (HTTPS) + cron** ไม่ต้องใช้ Vercel และ Neon
ยังต้องใช้ **Resend** สำหรับส่งอีเมล (ระบบยังไม่รองรับ SMTP ทั่วไป) · คู่มือแบบ Vercel/Neon อยู่ที่ [docs/DEPLOYMENT_TH.md](docs/DEPLOYMENT_TH.md)

> **อ่านก่อน: อะไรที่ตรวจสอบแล้ว และอะไรที่ยังไม่ได้ตรวจสอบ**
>
> * **รันจริงในเครื่องผู้พัฒนาแล้ว (Ubuntu 24.04, PostgreSQL 16, Node 22):** สร้าง role และฐานข้อมูลด้วยสิทธิ์ธรรมดา (ไม่ใช่ superuser), `pnpm db:migrate`, grants, `pnpm bootstrap`, `pnpm verify:database` (ผ่าน 13/13 ตอนที่เขียนคู่มือนี้ ปัจจุบันมี 15 ข้อ — เพิ่มข้อตรวจสิทธิ์ของสวิตช์สมัครสมาชิก — ผ่านครบ 15/15 กับฐานทดสอบในเครื่อง), `pnpm build`, `next start -H 127.0.0.1` ในโหมด production, อัปโหลด/ดาวน์โหลดไฟล์แนบลงโฟลเดอร์, สคริปต์ tick (ทั้งรหัสถูกและผิด), `scripts/backup.sh` พร้อมเข้ารหัสและถอดรหัสกลับ, `pnpm verify:attachments`
> * **ยังไม่ได้รันบน VPS จริง:** คำสั่ง `apt`, ไฟล์ systemd (ตรวจไวยากรณ์ด้วย `systemd-analyze verify` แล้วเท่านั้น), Caddy, ufw, การขอใบรับรอง HTTPS, Resend จริง ผมไม่มีเซิร์ฟเวอร์ให้ทดสอบ ข้อความที่มาจากความรู้ทั่วไปและไม่ได้ตรวจ ติดป้าย **(ตรวจสอบเอง)**
> * ถ้าขั้นไหนไม่เป็นไปตามคู่มือ ส่งข้อความ error มาให้ผม ผมแก้คู่มือให้

## สิ่งที่ต้องมี

| สิ่งที่ต้องมี | หมายเหตุ |
|---|---|
| VPS ที่ใช้ **Ubuntu 24.04 LTS** (คู่มือเขียนสำหรับตัวนี้) | Debian 12 ใกล้เคียง ที่อื่นต้องปรับคำสั่งเอง |
| RAM: **รันปกติ 1 GB พอ**, **ตอน build ต้องมากกว่านั้น** | วัดจริง: `pnpm build` ใช้เวลา ~47 วินาที (4 core) และ process ที่ใหญ่สุดใช้ RAM ~**2.1 GB** ถ้า VPS มี RAM น้อยกว่า ~4 GB ให้เพิ่ม swap (ขั้น 1) ส่วนแอปตอนรันใช้ ~250–300 MB หลังใช้งานเบา ๆ (ยังไม่ได้วัดตอนมีคนใช้เยอะ) |
| โดเมน และตั้ง **A record ชี้มาที่ IP ของ VPS** | เช่น `tasks.example.com` ต้องเป็นโดเมนที่จะใช้ HTTPS ถาวร เพราะแอปส่ง HSTS 2 ปี (เบราว์เซอร์จะจำว่าโดเมนนี้ต้องเป็น HTTPS รวมถึงโดเมนย่อย) |
| บัญชี **Resend** + โดเมนส่งอีเมลที่ยืนยันแล้ว (SPF/DKIM) | ใช้ส่งอีเมลยืนยันสมัคร รีเซ็ตรหัส แจ้งเตือน ดู [DEPLOYMENT.md §3](docs/DEPLOYMENT.md) |
| สิทธิ์เข้า repo นี้ | repo เป็น **private** ใช้ deploy key แบบอ่านอย่างเดียว (ขั้น 4) |

## แผนผัง

```
อินเทอร์เน็ต ──443──▶ Caddy (HTTPS, ใบรับรองอัตโนมัติ)
                          │  ส่งต่อไป 127.0.0.1:3000 และ "เขียนทับ" X-Forwarded-For ด้วย IP จริงของผู้เรียก
                          ▼
                    แอป Next.js (systemd, ผู้ใช้ tasktracker, ฟังเฉพาะ 127.0.0.1)
                      │                       │
        PostgreSQL (127.0.0.1:5432)     โฟลเดอร์ไฟล์แนบ /var/lib/task-tracker/attachments
        role tt_app (สิทธิ์น้อย)
                      ▲
        cron ทุกนาที ─┘  เรียก /api/cron/tick (งานเบื้องหลัง: แจ้งเตือน อีเมล เตือน งานซ้ำ ล้างข้อมูล)
```

**ต่างจากบน Vercel:** ไม่มี Vercel Cron (ใช้ cron ของเครื่องแทน ถี่ได้ทุกนาทีโดยไม่เสียเงิน) · ไฟล์แนบเก็บในโฟลเดอร์บนดิสก์ ไม่ใช่ Vercel Blob และอัปโหลดได้ **สูงสุด 4 MB ต่อไฟล์** (ขีดจำกัด 25 MB แบบตรงเข้า Blob ใช้ไม่ได้) · ฐานข้อมูลอยู่ในเครื่องเดียวกัน ถ้าดิสก์พัง ข้อมูลหายหมด จึง **ต้องสำรองไปไว้ที่อื่น** (ขั้น 11)

---

## ขั้นที่ 1: เตรียมเซิร์ฟเวอร์

เข้า SSH ในฐานะผู้ใช้ที่ใช้ `sudo` ได้ (ไม่ใช่ root ตรง ๆ ถ้าทำได้)

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git curl ufw rsync cron openssl ca-certificates gnupg

# ไฟร์วอลล์: เปิดเฉพาะ SSH, HTTP, HTTPS  (ต้องอนุญาต SSH ก่อนเปิด ไม่งั้นจะล็อกตัวเองออก)
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

**ถ้า RAM น้อยกว่า ~4 GB ให้เพิ่ม swap** (ตอน `pnpm build` ใช้ RAM สูงสุด ~2.1 GB ใน process เดียว)

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h     # ควรเห็น Swap 4.0Gi
```

(ตัวเลือกอื่น: build บนเครื่องที่ RAM เยอะกว่า แล้วคัดลอกโฟลเดอร์ `.next` มา ต้องใช้ Node เวอร์ชันและระบบปฏิบัติการเดียวกัน)

## ขั้นที่ 2: ติดตั้ง Node.js 22, pnpm และ PostgreSQL

```bash
# Node 22 (ต้อง 22 ขึ้นไป; เวอร์ชันใน apt ของ Ubuntu เก่ากว่านี้ (ตรวจสอบเอง) จึงใช้ NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -        # (ตรวจสอบเอง: ดูสคริปต์ก่อนรัน หรือดูวิธีล่าสุดที่ nodesource.com)
sudo apt install -y nodejs
node -v                                  # ต้องขึ้น v22.x
which node                               # ต้องเป็น /usr/bin/node (ไฟล์ systemd ในขั้น 7 ใช้ path นี้)

sudo npm install -g pnpm@10.28.0         # เวอร์ชันตรงกับ packageManager ใน package.json
pnpm -v

# PostgreSQL (Ubuntu 24.04 ได้ PostgreSQL 16 ซึ่งมี extension pg_trgm ที่ระบบใช้อยู่แล้ว)
sudo apt install -y postgresql postgresql-client
sudo systemctl enable --now postgresql
sudo -u postgres psql -Atc "select version()"
```

PostgreSQL บน Ubuntu ฟังเฉพาะ `localhost` เป็นค่าเริ่มต้น **อย่าเปิดให้ภายนอกเข้าถึง** (ไฟร์วอลล์ข้างบนก็ไม่เปิดพอร์ต 5432)

## ขั้นที่ 3: สร้างฐานข้อมูลและ role (2 role แยกกัน)

| role | ใช้ทำอะไร | สิทธิ์ |
|---|---|---|
| `tt_owner` | เจ้าของฐานข้อมูล ใช้ตอน migrate / bootstrap เท่านั้น | ธรรมดา (ไม่ใช่ superuser) |
| `tt_app` | **แอปใช้ตอนรัน** | สิทธิ์น้อยที่สุด ระบบ **ปฏิเสธให้บริการ (HTTP 503)** ถ้า role ของแอปเป็น superuser, ข้าม row-level security ได้ หรือเป็นเจ้าของตาราง |

```bash
OWNER_PW=$(openssl rand -hex 24)     # hex เท่านั้น: ไม่มีอักขระพิเศษที่ทำให้ URL เพี้ยน
APP_PW=$(openssl rand -hex 24)

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE tt_owner LOGIN PASSWORD '$OWNER_PW' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE tt_app   LOGIN PASSWORD '$APP_PW'   NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE tasktracker OWNER tt_owner;
SQL

echo "OWNER_PW=$OWNER_PW"; echo "APP_PW=$APP_PW"      # จดไว้ใน password manager ตอนนี้เลย (ใช้ในขั้น 4)
```

## ขั้นที่ 4: ผู้ใช้ระบบ, โค้ด, ความลับ

```bash
# ผู้ใช้ที่รันแอป (ไม่มีรหัสผ่าน ล็อกอินตรงไม่ได้)
sudo adduser --system --group --home /opt/task-tracker --shell /bin/bash tasktracker
sudo chmod 755 /opt/task-tracker          # ให้ผู้ใช้ postgres อ่าน scripts/backup.sh ได้ในขั้น 11 (ความลับอยู่ใน /etc/task-tracker ไม่ใช่ที่นี่)
sudo install -d -o tasktracker -g tasktracker -m 700 /var/lib/task-tracker
sudo install -d -o tasktracker -g tasktracker -m 700 /var/lib/task-tracker/attachments
sudo install -d -o root -g tasktracker -m 750 /etc/task-tracker
```

**ดึงโค้ดจาก repo private ด้วย deploy key (อ่านอย่างเดียว)**

```bash
sudo -H -u tasktracker mkdir -m 700 /opt/task-tracker/.ssh
sudo -H -u tasktracker ssh-keygen -t ed25519 -N '' -C 'task-tracker-vps' -f /opt/task-tracker/.ssh/id_ed25519
sudo -H -u tasktracker sh -c 'ssh-keyscan github.com >> /opt/task-tracker/.ssh/known_hosts'
sudo cat /opt/task-tracker/.ssh/id_ed25519.pub
```

คัดลอกบรรทัดที่พิมพ์ออกมา ไปที่ GitHub: repo `Pittzaa/Task-detect` → **Settings → Deploy keys → Add deploy key** วางลงไป **ไม่ต้องติ๊ก "Allow write access"** (ชื่อหน้าจอ **(ตรวจสอบเอง)**) แล้วทำต่อ

```bash
sudo -H -u tasktracker git clone git@github.com:Pittzaa/Task-detect.git /opt/task-tracker/app
cd /opt/task-tracker/app
sudo -H -u tasktracker pnpm install --frozen-lockfile
```

**ไฟล์ความลับ 2 ไฟล์** (ห้าม commit ห้ามส่งทางแชท): `env` สำหรับแอป และ `owner.env` สำหรับงานดูแลฐานข้อมูล

```bash
# เปลี่ยน tasks.example.com เป็นโดเมนของคุณ, ใส่ RESEND_API_KEY จริง, EMAIL_FROM เป็นที่อยู่บนโดเมนที่ยืนยันกับ Resend แล้ว
sudo tee /etc/task-tracker/env >/dev/null <<EOF
APP_URL=https://tasks.example.com
DATABASE_URL=postgres://tt_app:${APP_PW}@127.0.0.1:5432/tasktracker
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
APP_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')
CRON_SECRET=$(openssl rand -hex 24)
RESEND_API_KEY=re_ใส่ของจริงตรงนี้
EMAIL_FROM=noreply@tasks.example.com
ATTACHMENTS_DIR=/var/lib/task-tracker/attachments
EOF
sudo chown root:tasktracker /etc/task-tracker/env && sudo chmod 640 /etc/task-tracker/env

# ฐานข้อมูลในฐานะเจ้าของ: อ่านได้เฉพาะ root (แอปต้องอ่านไม่ได้)
sudo tee /etc/task-tracker/owner.env >/dev/null <<EOF
DATABASE_URL_UNPOOLED=postgres://tt_owner:${OWNER_PW}@127.0.0.1:5432/tasktracker
EOF
sudo chown root:root /etc/task-tracker/owner.env && sudo chmod 600 /etc/task-tracker/owner.env

# จดค่าเหล่านี้ไว้ใน password manager (แยกจากเซิร์ฟเวอร์) แล้วล้างตัวแปรออกจาก shell
sudo grep -E '^(BETTER_AUTH_SECRET|APP_ENCRYPTION_KEY)=' /etc/task-tracker/env
unset OWNER_PW APP_PW
```

> * **ห้ามตั้ง `APP_ENV`** และห้ามตั้ง `NODE_ENV` เอง (`next start` ตั้ง `production` ให้) ระบบจะใช้กฎเข้มสุด และจะไม่เริ่มทำงานถ้าตั้งค่าไม่ครบ
> * **ห้ามเปลี่ยน `BETTER_AUTH_SECRET` ทีหลัง** ไม่งั้น 2FA ของทุกคนใช้ไม่ได้ (กู้ด้วย `pnpm auth:reset-2fa`) · **ห้ามทำ `APP_ENCRYPTION_KEY` หาย** ไม่งั้นถอดรหัส webhook Discord และโทเค็น Google ที่เก็บไว้ไม่ได้
> * **ส่งอีเมลแจ้งเตือนอัตโนมัติ:** เมื่อทำขั้นที่ 9 (cron ทุกนาที) หรือขั้นที่ 9ข (ตัวตรวจทุกวินาที) เสร็จแล้ว ให้ล็อกอินด้วยบัญชีผู้ดูแลแล้วเปิดสวิตช์ **ตั้งค่า → การแจ้งเตือน → ส่งอีเมลแจ้งเตือนอัตโนมัติ** และเลือก **ส่งเมื่อไร → ทันที** (ปิดอยู่ตอนเริ่มต้น: อีเมลรอให้ผู้ดูแลกดส่ง) บน VPS ไม่ต้องมีคนเข้าแอปมาปลุก เพราะ cron เรียกงานเบื้องหลังเองทุกนาที
> * ตัวแปรทั้งหมดอยู่ใน [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) · `ATTACHMENTS_DIR` ต้องเป็นพาธเต็ม และห้ามตั้งคู่กับ `BLOB_READ_WRITE_TOKEN`

## ขั้นที่ 5: สร้างตาราง, ให้สิทธิ์, สร้างองค์กรแรก

ใช้ `owner.env` (อ่านได้เฉพาะ root จึงรันด้วย `sudo bash -c`) · ทั้งหมดนี้ **รันจริงแล้ว** ในเครื่องผู้พัฒนาด้วย role แบบเดียวกัน

```bash
cd /opt/task-tracker/app

# 5.1 สร้างตาราง (migration)
sudo bash -c 'set -a; . /etc/task-tracker/owner.env; set +a; cd /opt/task-tracker/app && pnpm db:migrate'
#   → migrations applied

# 5.2 ให้สิทธิ์กับ role ของแอป (ข้อความ WARNING: no privileges were granted ... เกี่ยวกับ pg_trgm ไม่ใช่ปัญหา)
sudo bash -c 'set -a; . /etc/task-tracker/owner.env; set +a; cd /opt/task-tracker/app && psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -q -c "$(sed "s/{{APP_ROLE}}/tt_app/g" scripts/grants.sql)"'

# 5.3 สร้างองค์กรแรกและลิงก์เชิญผู้ดูแลคนแรก (ใช้ได้ครั้งเดียว อายุ 7 วัน)
sudo bash -c 'set -a; . /etc/task-tracker/owner.env; set +a; cd /opt/task-tracker/app && pnpm bootstrap --name "ชื่อองค์กรของคุณ" --slug acme --admin-email you@example.com --app-url https://tasks.example.com'
#   → พิมพ์ลิงก์ https://tasks.example.com/invite?token=...   (เก็บไว้ ใช้ในขั้น 10)

# 5.4 ตรวจว่าฐานข้อมูลถูกต้องในมุมมองของแอป (ต้องขึ้น DATABASE CHECK PASSED: 15/15)
sudo -H -u tasktracker bash -c 'set -a; . /etc/task-tracker/env; set +a; cd /opt/task-tracker/app && pnpm -s verify:database'
```

**หนึ่งระบบ = หนึ่งองค์กร** คำสั่ง `pnpm bootstrap` จะไม่ยอมสร้างองค์กรที่สอง (รันซ้ำด้วย `--slug` เดิมได้ ใช้ออกลิงก์เชิญใหม่ถ้าลิงก์หมดอายุ) **คนแรกที่รับคำเชิญคือผู้ดูแลสูงสุด (`orgadmin`)** ที่ทำได้ทุกอย่าง เปิด/ปิดการสมัครสมาชิกได้ที่ ตั้งค่า → ทั่วไป และลบแผนก ทีม โปรเจกต์ได้ที่หน้าโครงสร้างองค์กร (ผู้ดูแลคนอื่นที่เชิญเพิ่มมีสิทธิ์เท่ากันทุกอย่าง ไม่มี "เจ้าของ" ที่อยู่เหนือกว่า)
`--slug` คือรหัสองค์กร ใช้พิมพ์ในหน้า "ขอสิทธิ์เข้าใช้งาน" เฉพาะเมื่อมีมากกว่าหนึ่งองค์กร (มีองค์กรเดียวหน้านั้นไม่ถามรหัส)

## ขั้นที่ 6: build

```bash
cd /opt/task-tracker/app
sudo -H -u tasktracker pnpm build        # ราว 1 นาทีขึ้นไป ถ้า RAM น้อยแล้วโดนฆ่า (Killed) ให้เพิ่ม swap แล้วรันใหม่
```

## ขั้นที่ 7: รันเป็นบริการ (systemd)

แอปรัน **ฟังเฉพาะ `127.0.0.1`** (ภายนอกต่อตรงไม่ได้ ต้องผ่าน Caddy) เริ่มเองเมื่อเครื่องบูต และเริ่มใหม่เองเมื่อล้ม

```bash
sudo tee /etc/systemd/system/task-tracker.service >/dev/null <<'EOF'
[Unit]
Description=Task Tracker
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=tasktracker
Group=tasktracker
WorkingDirectory=/opt/task-tracker/app
EnvironmentFile=/etc/task-tracker/env
ExecStart=/usr/bin/node /opt/task-tracker/app/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now task-tracker
sudo systemctl status task-tracker --no-pager
curl -s -o /dev/null -w "ตอบ HTTP %{http_code}\n" http://127.0.0.1:3000/login      # ต้องได้ 200
```

ดู log: `sudo journalctl -u task-tracker -f` · ถ้า `status` ขึ้น failed ให้ดู log: สาเหตุที่พบบ่อยคือตัวแปรใน `/etc/task-tracker/env` ไม่ครบหรือผิด (แอปบอกชื่อตัวแปรที่ผิด ไม่บอกค่า)

## ขั้นที่ 8: HTTPS ด้วย Caddy

Caddy ขอและต่ออายุใบรับรอง HTTPS ให้เอง **โดเมนต้องชี้มาที่ IP ของ VPS แล้ว และพอร์ต 80/443 ต้องเปิด**

```bash
sudo apt install -y caddy          # (ตรวจสอบเอง: ได้ Caddy 2.x จาก Ubuntu ถ้าต้องการรุ่นใหม่กว่า ดู caddyserver.com/docs/install)

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
tasks.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		# เขียนทับด้วย IP จริงของผู้เรียก: ตัวจำกัดจำนวนครั้งล็อกอินของ Better Auth ดูจาก X-Forwarded-For
		# ถ้าไม่เขียนทับ คนภายนอกส่งค่าปลอมมาเลี่ยงตัวจำกัดได้ (ตรวจสอบเอง: ผมไม่ได้รัน Caddy จริง)
		header_up X-Forwarded-For {remote_host}
	}
}
EOF
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

เปิด `https://tasks.example.com/login` ควรขึ้นหน้าเข้าสู่ระบบ (ภาษาไทย) พร้อมกุญแจ HTTPS ถ้าใบรับรองไม่ออก ดู `sudo journalctl -u caddy -n 50` (มักเป็นเพราะ DNS ยังไม่ชี้มา หรือพอร์ต 80 ถูกปิด)

<details>
<summary>ถ้าใช้ nginx แทน Caddy (ไม่ได้ทดสอบ)</summary>

```nginx
server {
    server_name tasks.example.com;
    client_max_body_size 5m;                      # ค่าเริ่มต้น 1 MB จะบล็อกการแนบไฟล์ (ระบบรับไฟล์ได้ถึง 4 MB)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;      # "เขียนทับ" ไม่ใช่ $proxy_add_x_forwarded_for
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
แล้วขอใบรับรองด้วย `certbot --nginx` (ตรวจสอบเอง)
</details>

## ขั้นที่ 9: ตัวตั้งเวลา (cron ทุกนาที)

งานเบื้องหลังทั้งหมด (สร้างแจ้งเตือนในแอป, ส่งอีเมล/Discord, เตือนก่อนครบกำหนด, สร้างงานซ้ำ, ล้างข้อมูลเก่า) ทำงานเมื่อมีใครเรียก `/api/cron/tick` ถ้าไม่ตั้งขั้นนี้ อีเมลอัตโนมัติ (สวิตช์ในหน้าตั้งค่า) จะส่งช้าหรือไม่ถูกส่ง และงานบางอย่างจะรอจนมีคนใช้แอป

```bash
sudo tee /usr/local/bin/task-tracker-tick >/dev/null <<'EOF'
#!/usr/bin/env bash
# เรียกทุกนาทีโดย cron: ให้แอปทำงานเบื้องหลัง
set -euo pipefail
secret="$(grep -E '^CRON_SECRET=' /etc/task-tracker/env | head -n1 | cut -d= -f2-)"
[ -n "$secret" ] || { echo "CRON_SECRET is not set in /etc/task-tracker/env" >&2; exit 1; }
# flock -n: ถ้ารอบก่อนยังไม่จบ ข้ามนาทีนี้ ไม่สะสมเป็นกอง
exec flock -n /run/lock/task-tracker-tick.lock curl -fsS -m 60 -o /dev/null -H "Authorization: Bearer ${secret}" http://127.0.0.1:3000/api/cron/tick
EOF
sudo chmod 755 /usr/local/bin/task-tracker-tick

echo '* * * * * tasktracker /usr/local/bin/task-tracker-tick' | sudo tee /etc/cron.d/task-tracker
sudo chmod 644 /etc/cron.d/task-tracker

# ลองรันเอง: ไม่มีข้อความ error และ exit 0 = สำเร็จ
sudo -H -u tasktracker /usr/local/bin/task-tracker-tick; echo "exit=$?"
```

(ลองกับ secret ผิดแล้ว: สคริปต์จบด้วย exit 22 และข้อความ `401` ตามที่ควร) ดูผล: `grep CRON /var/log/syslog | tail` หรือเข้าหน้า **ตั้งค่า → การเชื่อมต่อ → งานเบื้องหลัง** ในแอป ต้องไม่มีงานค้างหรือตาย

## ขั้นที่ 9ข (ทางเลือก): ตรวจงานเบื้องหลังทุกวินาที

cron ของเครื่องถี่สุดทุก 1 นาที ถ้าอยากให้อีเมลแจ้งเตือนออกภายในไม่กี่วินาที (โหมด **ส่งทันที**) ให้รันตัวตรวจงาน `scripts/poller.mjs` แทน cron ของขั้น 9 มันเป็นสคริปต์ Node ธรรมดา ไม่ต้องติดตั้งอะไรเพิ่ม ทำงานเป็นวง ทีละคำขอ (ไม่ซ้อนกัน): ทุก 1 วินาทีเรียก `GET /api/cron/tick?fast=1` (ทำเฉพาะสิ่งที่คนรออยู่: แจ้งเตือน อีเมล เตือนก่อนครบกำหนด งานซ้ำ) และทุก 60 วินาทีเรียกรอบเต็มเหมือน cron (อีเมลสรุป ล้างข้อมูลตามนโยบาย ฯลฯ) ถ้าเซิร์ฟเวอร์ตอบผิดพลาดหรือไม่ตอบ มันรอนานขึ้นทีละเท่าตัว (สูงสุด 30 วินาที) แล้วกลับมาที่ทุก 1 วินาทีเมื่อกลับมาปกติ

```bash
sudo tee /etc/systemd/system/task-tracker-poller.service >/dev/null <<'EOF'
[Unit]
Description=Task Tracker poller (background work every second)
After=task-tracker.service
Wants=task-tracker.service

[Service]
Type=simple
User=tasktracker
Group=tasktracker
WorkingDirectory=/opt/task-tracker/app
EnvironmentFile=/etc/task-tracker/env
Environment=POLL_URL=http://127.0.0.1:3000
Environment=POLL_INTERVAL_MS=1000
ExecStart=/usr/bin/node /opt/task-tracker/app/scripts/poller.mjs
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

sudo rm -f /etc/cron.d/task-tracker          # ไม่ต้องใช้ cron ของขั้น 9 คู่กัน (รันคู่กันไม่เสียหาย แต่ซ้ำซ้อน)
sudo systemctl daemon-reload
sudo systemctl enable --now task-tracker-poller
sudo journalctl -u task-tracker-poller -n 5 --no-pager     # ต้องเห็น "poller: http://127.0.0.1:3000, every 1000 ms" และไม่มี error
```

ใช้ `CRON_SECRET` ตัวเดียวกับแอป (อ่านจาก `/etc/task-tracker/env`) ถ้าไม่ตรง log จะขึ้น `answered 401` ปรับความถี่ด้วย `POLL_INTERVAL_MS` (ต่ำสุด 250) แต่ละรอบเร็วใช้คำสั่งฐานข้อมูลเล็ก ๆ ไม่กี่คำสั่ง (ตรวจว่ามีเหตุการณ์ค้างไหม ลงคิวงานตามช่วงเวลา และหยิบงานที่ถึงกำหนด) ซึ่งบนเครื่องเดียวกับฐานข้อมูลเบามาก หลังติดตั้งให้เปิดสวิตช์ส่งอีเมลอัตโนมัติและเลือก **ทันที** ที่ ตั้งค่า → การแจ้งเตือน

> **ทดสอบแล้ว:** ตรรกะของตัวตรวจ (ลำดับรอบเร็ว/เต็ม การรอเมื่อผิดพลาด การหยุดเมื่อถูกสั่ง) มีเทสต์หน่วย และเคยรันกับเซิร์ฟเวอร์แอปจริงในเครื่องผู้พัฒนา (ดูตัวเลขความหน่วงใน [docs/TESTING.md](docs/TESTING.md)) **ยังไม่ได้ทดสอบ:** ไฟล์ systemd ข้างบนบน VPS จริง และการรันต่อเนื่องหลายวัน

## ขั้นที่ 10: ตรวจสอบและเริ่มใช้

```bash
# จากเครื่องไหนก็ได้ที่มีโค้ดนี้ (หรือบน VPS): ตรวจเว็บที่ deploy แล้ว
cd /opt/task-tracker/app
sudo -H -u tasktracker env APP_URL=https://tasks.example.com CRON_SECRET="$(sudo grep ^CRON_SECRET= /etc/task-tracker/env | cut -d= -f2-)" pnpm -s smoke
```

แล้วลองเองทีละอย่าง (สคริปต์ทำแทนไม่ได้):

* [ ] เปิดลิงก์เชิญจากขั้น 5.3 → สมัคร → **อีเมลยืนยันต้องมาถึงกล่องจดหมาย** (พิสูจน์ Resend) → ล็อกอิน
* [ ] สร้างแผนก ทีม โปรเจกต์ งาน · แนบไฟล์เล็ก (ต้องแนบได้ ดาวน์โหลดแล้วตรงต้นฉบับ) · ลองแนบไฟล์เกิน 4 MB (ต้องโดนปฏิเสธด้วยข้อความชัดเจน)
* [ ] เปิดสวิตช์ **ส่งอีเมลแจ้งเตือนอัตโนมัติ** (ตั้งค่า → การแจ้งเตือน) แล้วมอบหมายงานให้อีกบัญชี: แจ้งเตือนในแอปและอีเมลมาถึงภายใน ~1 นาที เมื่อ cron ทุกนาทีจากขั้น 9 ติดตั้งแล้ว (พิสูจน์ cron; ถ้ายังไม่เปิดสวิตช์ จะมีเฉพาะแจ้งเตือนในแอป และอีเมลรอผู้ดูแลกดส่ง)
* [ ] เปิด 2FA ออกแล้วเข้าใหม่ด้วยรหัสและ backup code
* [ ] รีสตาร์ตเครื่อง (`sudo reboot`) แล้วเว็บขึ้นเองโดยไม่ต้องทำอะไร
* [ ] ชวนอีกคนจากหน้า สมาชิก → คำเชิญ

รายการตรวจละเอียดอีกชุดอยู่ใน [docs/DEPLOYMENT.md §8–§9](docs/DEPLOYMENT.md) (ข้อที่เกี่ยวกับ Vercel/Neon/Blob ข้ามได้)

## ขั้นที่ 11: สำรองข้อมูล (สำคัญที่สุดของการ host เอง)

ทุกอย่างอยู่ในเครื่องเดียว ดิสก์พังหรือเครื่องโดนลบ = ข้อมูลหายหมด ต้องสำรอง **สองอย่าง**: ฐานข้อมูล และโฟลเดอร์ไฟล์แนบ แล้ว **คัดลอกออกไปไว้นอกเครื่องนี้**

```bash
sudo apt install -y rsync        # ถ้ายังไม่มี

# รหัสผ่านเข้ารหัสไฟล์สำรอง: สร้างแล้ว "จดไว้นอกเซิร์ฟเวอร์" (ถ้าหาย ถอดรหัสไฟล์สำรองไม่ได้)
openssl rand -base64 32 | sudo tee /etc/task-tracker/backup.pass >/dev/null
sudo chmod 600 /etc/task-tracker/backup.pass && sudo cat /etc/task-tracker/backup.pass

sudo tee /usr/local/bin/task-tracker-backup >/dev/null <<'EOF'
#!/usr/bin/env bash
# สำรองรายวัน: ฐานข้อมูลเข้ารหัส + สำเนาโฟลเดอร์ไฟล์แนบ ลบของเก่าเกิน 14 วัน (รันด้วย root จาก cron)
set -euo pipefail
dest=/var/backups/task-tracker
pass_file=/etc/task-tracker/backup.pass
keep_days=14

install -d -m 700 -o postgres -g postgres "$dest"
# ฐานข้อมูล: pg_dump ต้องใช้ role ที่ข้าม row-level security ได้ ใช้ superuser postgres ผ่าน socket ในเครื่อง
sudo -u postgres env DATABASE_URL_UNPOOLED='postgresql:///tasktracker' BACKUP_PASSPHRASE="$(cat "$pass_file")" \
  bash /opt/task-tracker/app/scripts/backup.sh "$dest"
# ไฟล์แนบ (rsync: คัดลอกเฉพาะที่เปลี่ยน)
install -d -m 700 "$dest/attachments"
rsync -a --delete /var/lib/task-tracker/attachments/ "$dest/attachments/"
# ล้างไฟล์สำรองฐานข้อมูลที่เก่าเกินกำหนด
find "$dest" -maxdepth 1 -name 'taskdb-*' -mtime +"$keep_days" -delete
echo "backup finished: $(date -u +%FT%TZ)"
EOF
sudo chmod 755 /usr/local/bin/task-tracker-backup

echo '17 3 * * * root /usr/local/bin/task-tracker-backup >> /var/log/task-tracker-backup.log 2>&1' | sudo tee /etc/cron.d/task-tracker-backup
sudo chmod 644 /etc/cron.d/task-tracker-backup

sudo /usr/local/bin/task-tracker-backup && sudo ls -la /var/backups/task-tracker      # ลองรันเองหนึ่งครั้ง
```

**คัดลอกออกนอกเครื่อง** (ตัวอย่าง: ไปเครื่องอื่นด้วย rsync/scp หรือไปที่เก็บของบนคลาวด์ด้วย rclone) ไฟล์ฐานข้อมูลเข้ารหัสแล้ว (`*.dump.enc`) ส่วนโฟลเดอร์ `attachments` **ไม่ได้เข้ารหัส** ใช้ที่เก็บที่เข้ารหัสหรือเชื่อถือได้ ตั้ง cron ฝั่งเครื่องปลายทางให้ดึงไปทุกวัน (ตรวจสอบเอง)

**ซ้อมกู้คืนอย่างน้อยหนึ่งครั้งก่อนเก็บข้อมูลจริง** ขั้นตอนกู้คืน (ถอดรหัส, `pg_restore` ลงฐานชั่วคราว, `pnpm verify:attachments`) อยู่ใน [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) ใช้ได้กับ VPS (ข้อที่พูดถึง Neon ข้ามได้) ทดสอบแล้วว่าไฟล์ที่ `backup.sh` สร้าง ตรวจ checksum ผ่านและถอดรหัสกลับได้

กู้เฉพาะไฟล์แนบหรือเช็กว่าตรงกับฐานข้อมูลไหม: `pnpm verify:attachments` (รันด้วย env ของแอป) และ `pnpm backup:attachments --to fs:/ที่/อื่น` (ตรวจ hash และคัดลอกเฉพาะที่เปลี่ยน)

## ขั้นที่ 12: อัปเดตเวอร์ชัน

ทุกครั้งที่มีโค้ดใหม่ ทำตามลำดับนี้ (migration ในโปรเจกต์นี้เพิ่มอย่างเดียว เวอร์ชันเก่ายังทำงานได้ระหว่างอัปเดต)

```bash
cd /opt/task-tracker/app
sudo -H -u tasktracker git pull
sudo -H -u tasktracker pnpm install --frozen-lockfile
sudo bash -c 'set -a; . /etc/task-tracker/owner.env; set +a; cd /opt/task-tracker/app && pnpm db:migrate && psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -q -c "$(sed "s/{{APP_ROLE}}/tt_app/g" scripts/grants.sql)"'
sudo chown -R tasktracker:tasktracker /opt/task-tracker/app        # กันไฟล์ที่ root เผลอสร้าง
sudo -H -u tasktracker pnpm build
sudo systemctl restart task-tracker
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3000/login
sudo -H -u tasktracker bash -c 'set -a; . /etc/task-tracker/env; set +a; cd /opt/task-tracker/app && pnpm -s verify:database'   # ต้องขึ้น DATABASE CHECK PASSED (ตรวจด้วยว่า grants ครบ)
```

**ย้อนกลับ:** `git checkout <commit เดิม>` แล้ว `pnpm build` และ `systemctl restart` ใหม่ (ฐานข้อมูลไม่ต้องย้อน เพราะ migration เพิ่มอย่างเดียว **แต่ build ที่เก่ากว่า migration 0014 ไม่รู้จักสวิตช์เปิด/ปิดสมัครสมาชิก จึงเปิดรับสมัครให้ทุกคนจนกว่าจะอัปเดตกลับ ตรวจที่ ตั้งค่า → ทั่วไป**) ถ้าเกิดหายนะ กู้จากไฟล์สำรอง

---

## ความปลอดภัย: เช็กลิสต์ของ VPS

- [ ] SSH ใช้กุญแจ ปิดรหัสผ่าน (`PasswordAuthentication no` ใน `/etc/ssh/sshd_config.d/`, **ตรวจสอบว่าเข้าด้วยกุญแจได้ก่อนปิด**) และห้ามล็อกอิน root ตรง
- [ ] ไฟร์วอลล์เปิดเฉพาะ 22/80/443 (`sudo ufw status`) · PostgreSQL ฟังเฉพาะ localhost (`sudo ss -ltnp | grep 5432` ต้องเห็น `127.0.0.1`)
- [ ] แอปฟังเฉพาะ `127.0.0.1:3000` (ตรวจแล้วว่า `-H 127.0.0.1` ทำให้ต่อผ่านอินเทอร์เฟซอื่นไม่ได้) และ Caddy **เขียนทับ** `X-Forwarded-For`
- [ ] `/etc/task-tracker/env` สิทธิ์ 640, `/etc/task-tracker/owner.env` และ `backup.pass` สิทธิ์ 600 อ่านได้เฉพาะ root (แอปอ่าน owner.env ไม่ได้)
- [ ] เปิดอัปเดตความปลอดภัยอัตโนมัติ: `sudo apt install -y unattended-upgrades` แล้ว `sudo dpkg-reconfigure -plow unattended-upgrades`
- [ ] (แนะนำ) `sudo apt install -y fail2ban` กันคนเดาผ่าน SSH
- [ ] ไฟล์สำรองมีสำเนา **นอกเครื่อง** และซ้อมกู้คืนแล้ว
- [ ] `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, รหัสผ่านไฟล์สำรอง เก็บใน password manager แยกจากเซิร์ฟเวอร์
- [ ] มีตัวเฝ้าระวัง เช่น บริการ uptime ที่เรียก `https://โดเมน/login` ทุก 5 นาที (ตรวจสอบเอง) หรือเรียก `/api/health/ready` พร้อม `Authorization: Bearer <CRON_SECRET>` ได้ผล `{"status":"ok", ...}`
- [ ] อ่านข้อจำกัดและความเสี่ยงที่ยอมรับใน [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) และ [docs/SECURITY.md](docs/SECURITY.md)

## แก้ปัญหา

| อาการ | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| ทุกหน้าตอบ 503 "Service unavailable" | role ในฐานข้อมูลของแอปข้าม RLS ได้ หรือเป็นเจ้าของตาราง | `DATABASE_URL` ต้องเป็น `tt_app` ไม่ใช่ `tt_owner` หรือ `postgres` (ดู log: `journalctl -u task-tracker`) |
| `systemctl status` = failed ทันที | ตัวแปรใน `/etc/task-tracker/env` ไม่ครบ/ผิด | ดู `journalctl -u task-tracker -n 30` แอปบอกชื่อตัวแปรที่ผิด แก้แล้ว `sudo systemctl restart task-tracker` |
| `APP_ENV` / `production build ... may only be served at localhost` | ตั้ง `APP_ENV` ไว้ | ลบ `APP_ENV` ออกจาก env file |
| `ATTACHMENTS_DIR ... must be an absolute path` หรือ `set either ... not both` | ใส่พาธสั้น หรือตั้งคู่กับ `BLOB_READ_WRITE_TOKEN` | ใช้พาธเต็ม `/var/lib/task-tracker/attachments` และลบ `BLOB_READ_WRITE_TOKEN` |
| แนบไฟล์ไม่ได้: error / permission denied | โฟลเดอร์ไฟล์แนบไม่ใช่ของ `tasktracker` | `sudo chown -R tasktracker:tasktracker /var/lib/task-tracker && sudo chmod 700 /var/lib/task-tracker/attachments` |
| แนบไฟล์ใหญ่กว่า 1 MB ไม่ได้ (ใช้ nginx) | `client_max_body_size` เริ่มต้น 1 MB | ตั้งเป็น 5m ตามตัวอย่างด้านบน (Caddy ไม่มีขีดจำกัดนี้) |
| ไม่มีแจ้งเตือน/อีเมลแจ้งเตือนไม่มา | **สวิตช์ส่งอีเมลอัตโนมัติยังปิดอยู่ (ค่าเริ่มต้น: อีเมลรอผู้ดูแลกดส่ง)** · หรือเลือก "วันละครั้ง 23:00" (บน VPS เลือก "ทันที") · หรือ cron/poller ไม่ทำงาน หรือ `CRON_SECRET` ไม่ตรง | ตั้งค่า → การแจ้งเตือน → เปิดสวิตช์ เลือก "ทันที" · `sudo -H -u tasktracker /usr/local/bin/task-tracker-tick; echo $?` ต้องได้ 0 · ดู `/etc/cron.d/task-tracker` หรือ `journalctl -u task-tracker-poller` |
| อีเมลยืนยันสมัครไม่มา | Resend: โดเมนยังไม่ verified, `EMAIL_FROM` ไม่ใช่ที่อยู่บนโดเมนนั้น, หรือ API key ผิด | ดูหน้า Logs ใน Resend และ `journalctl -u task-tracker` |
| ล็อกอินแล้ว "Cross-origin request blocked" (403) | `APP_URL` ไม่ตรงกับโดเมนที่เปิดอยู่ (http/https, www ต่างกัน) | แก้ `APP_URL` ให้ตรงตัวอักษรกับ URL ที่ใช้จริง แล้ว restart |
| Caddy ขอใบรับรองไม่ได้ | DNS ยังไม่ชี้มา หรือพอร์ต 80 ปิด | `dig +short tasks.example.com` ต้องได้ IP ของ VPS · `sudo ufw status` · `journalctl -u caddy` |
| `pnpm build` ถูกฆ่า (Killed) | RAM ไม่พอ | เพิ่ม swap (ขั้น 1) แล้วรันใหม่ |
| ล็อกอินไม่ได้หลังเปลี่ยน `BETTER_AUTH_SECRET` | 2FA เสียทั้งหมด | `sudo -H -u tasktracker bash -c 'set -a; . /etc/task-tracker/env; set +a; cd /opt/task-tracker/app && pnpm auth:reset-2fa --all --yes'` |

## ข้อจำกัดของการ host เอง

* **ไฟล์แนบสูงสุด 4 MB ต่อไฟล์** (ขีดจำกัดเดิมออกแบบตามข้อจำกัดของ Vercel) ถ้าต้องการเพิ่ม บอกผมได้ เป็นการแก้โค้ด (ค่าคงที่ใน `src/domain/files.ts` และตรวจกับ proxy)
* **ส่งอีเมลได้ทางเดียวคือ Resend** (ยังไม่มี SMTP) ถ้าต้องการ SMTP ของตัวเอง ต้องเพิ่มโค้ด
* **เครื่องเดียว = จุดล้มเหลวจุดเดียว** ไม่มี failover ถ้าเครื่องล่ม เว็บล่มจนกว่าจะกู้
* ยังไม่มี `Dockerfile` / `docker-compose` (ถ้าต้องการ บอกผมได้ แต่ผมทดสอบ Docker ในเครื่องนี้ไม่ได้ จะบอกชัดว่าไม่ได้ลอง)
* ผมไม่ได้ทดสอบกับ VPS จริง ดูกล่อง "อ่านก่อน" ด้านบน
