# Task Tracker — ระบบติดตามงานสำหรับองค์กร

ระบบติดตามงานสำหรับองค์กร (แผนก → ทีม → โปรเจกต์ → งาน) **หนึ่งระบบที่ติดตั้ง = หนึ่งองค์กร** สร้างด้วย **Next.js 16 / React 19 / TypeScript**, ฐานข้อมูล **Neon PostgreSQL**, โฮสต์บน **Vercel**, ส่งอีเมลด้วย **Resend**
ผู้ใช้คนแรกที่ได้รับเชิญคือ **ผู้ดูแลสูงสุด** (`orgadmin`) เปิด/ปิดการสมัครสมาชิกใหม่ได้ และลบแผนก ทีม โปรเจกต์ได้
รองรับภาษาไทย (ค่าเริ่มต้น) และอังกฤษ ข้อมูลถูกแยกต่อองค์กรเด็ดขาดสองชั้น (ในโค้ด **และ** ด้วย row-level security ของ PostgreSQL) สิทธิ์แบบกำหนดขอบเขต (องค์กร/แผนก/ทีม/โปรเจกต์)
มุมมอง List / Board / ปฏิทิน / Timeline / Dashboard / งานของฉัน, ค้นหา, views ที่บันทึกได้, custom fields, แก้หลายงานพร้อมกัน, งานซ้ำ (recurring),
แจ้งเตือน (ในแอป อีเมล Discord), ซิงก์ Google Calendar ทางเดียว, ไฟล์แนบแบบปิดไม่เป็นสาธารณะ (สูงสุด 25 MB เมื่อตั้งค่า Vercel Blob), Markdown แบบปลอดภัยในคอมเมนต์และคำอธิบาย,
audit log 90 วัน, งานเบื้องหลังที่ไม่หาย, อัปเดตหน้าจออัตโนมัติ, ส่งออกข้อมูลส่วนตัวและลบบัญชี, ส่งออก/นำเข้าทีละองค์กร, ล็อกอินด้วย 2FA

> **สถานะ: พร้อมให้ทดลอง deploy แต่ยังไม่เคยขึ้นบริการจริงที่ไหนเลย** ทุกอย่างสร้างและทดสอบกับ PostgreSQL 16 ในเครื่องและ production build ในเครื่อง
> **ไม่เคยเชื่อมต่อ** Vercel, Neon, Resend, Google, Discord และ Vercel Blob จริง อ่าน [docs/READINESS_REPORT.md](docs/READINESS_REPORT.md) (อะไรตรวจแล้ว อะไรยังไม่ได้ตรวจ สิ่งที่ต้องทำก่อนเปิดใช้)
> และ [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) ก่อนเปิดให้คนอื่นใช้

---

## ติดตั้งและ deploy (เริ่มที่นี่)

ใช้ **Vercel** (โฮสต์ + ตัวตั้งเวลา + ที่เก็บไฟล์แนบ Blob) + **Neon** (ฐานข้อมูล) + **Resend** (ส่งอีเมล)
**จะ host บน VPS ของตัวเองแทน Vercel + Neon: ดู [README_VPS.md](README_VPS.md)** (PostgreSQL + Caddy + systemd + cron ในเครื่องเดียว)
คู่มือทีละขั้นละเอียดพร้อมเหตุผล (แบบ Vercel + Neon): **[docs/DEPLOYMENT_TH.md](docs/DEPLOYMENT_TH.md)** · เอกสารอ้างอิง: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · ตัวแปรทั้งหมด: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)

สรุปลำดับ (ทำจากบนลงล่าง อย่าข้ามขั้น):

**1. เตรียมความลับ** (เก็บในที่ปลอดภัยแยกจาก Vercel เช่น password manager อย่าส่งทางแชทหรือ commit ลง git)
```bash
openssl rand -base64 48    # → BETTER_AUTH_SECRET   (ตั้งให้ถูกตั้งแต่แรก: เปลี่ยนทีหลังแล้ว 2FA ของทุกคนใช้ไม่ได้)
openssl rand -base64 32    # → APP_ENCRYPTION_KEY   (หายแล้ว webhook Discord และโทเค็น Google ที่เก็บไว้ถอดรหัสไม่ได้)
openssl rand -hex 24       # → CRON_SECRET
```

**2. Neon (ฐานข้อมูล)** สร้างโปรเจกต์ใน region ใกล้ region ของ function บน Vercel แล้วทำบน **เครื่องของคุณ**
```bash
# 2.1 สร้าง role สำหรับแอป (ใน SQL Editor ของ Neon, ในฐานะ owner) — ห้ามเป็น superuser และห้ามมี BYPASSRLS
#     CREATE ROLE tt_app LOGIN PASSWORD '<รหัสผ่านสุ่มยาว ๆ>' NOSUPERUSER NOBYPASSRLS;

# 2.2 สร้างตาราง และให้สิทธิ์ role ของแอป (ใช้ connection string แบบ direct ของ owner)
DATABASE_URL_UNPOOLED='<owner direct>' pnpm db:migrate
psql '<owner direct>' -v ON_ERROR_STOP=1 -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"

# 2.3 สร้างองค์กร (มีได้องค์กรเดียวต่อระบบ) พิมพ์ลิงก์เชิญใช้ครั้งเดียวสำหรับผู้ดูแลสูงสุดคนแรก
DATABASE_URL_UNPOOLED='<owner direct>' pnpm bootstrap --name "ชื่อองค์กร" --slug acme --admin-email you@example.com --app-url https://โดเมนของคุณ
```
> **องค์กรเดียวต่อระบบ:** รัน `pnpm bootstrap` อีกครั้งด้วย `--slug` อื่นจะถูกปฏิเสธ (ด้วย `--slug` เดิมจะออกลิงก์เชิญใหม่ให้) คนที่รับคำเชิญคือผู้ดูแลสูงสุด ปิด/เปิดการสมัครสมาชิกได้ที่ **ตั้งค่า → ทั่วไป** (ค่าเริ่มต้นคือเปิด; ปิดแล้วเฉพาะอีเมลที่มีคำเชิญค้างอยู่ที่สมัครได้) และลบแผนก/ทีม/โปรเจกต์ได้ที่หน้า **โครงสร้างองค์กร** ผู้ดูแลที่เชิญเพิ่มภายหลังมีสิทธิ์เท่ากันทุกอย่าง (ไม่มี "เจ้าของ" เหนือกว่า — ดู [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md))
>
> **สำคัญ:** `DATABASE_URL` บน Vercel ต้องเป็น connection string (แบบ pooled) ของ role **`tt_app`** เท่านั้น **ห้ามนำ string ของ owner หรือ `DATABASE_URL_UNPOOLED` ไปใส่ใน Vercel** ถ้าใช้ role ที่ข้ามการแยกข้อมูลได้ หรือเป็นเจ้าของตาราง ระบบจะปฏิเสธให้บริการ (HTTP 503) เอง
> ถ้าสร้าง Neon ผ่านปุ่ม Integration ใน Vercel เท่าที่ทราบ Vercel จะใส่ string ของ owner ให้เองใน environment variables (ตรวจเองในหน้า Settings → Environment Variables) ต้องแก้ตาม [DEPLOYMENT_TH ขั้น 3.1ข](docs/DEPLOYMENT_TH.md)

**3. Resend (อีเมล)** เพิ่มและยืนยันโดเมนส่งอีเมล (SPF/DKIM) → สร้าง API key แบบส่งอีเมล → จะได้ `RESEND_API_KEY` และ `EMAIL_FROM` (ที่อยู่บนโดเมนที่ยืนยันแล้ว)

**4. Vercel Blob (ไฟล์แนบ)** สร้าง Blob store แบบ **private** เชื่อมกับโปรเจกต์ → จะได้ `BLOB_READ_WRITE_TOKEN` (ถ้าไม่ตั้ง จะแนบไฟล์ไม่ได้ ส่วนอื่นใช้ได้ตามปกติ)

**5. Vercel (โฮสต์)** Import repository นี้จาก GitHub (Framework: Next.js) แล้ว **ตั้ง environment variables ก่อนกด Deploy** — ถ้าขาด production จะไม่ยอมเริ่มทำงาน

| ตัวแปร | ค่า |
|---|---|
| `DATABASE_URL` | pooled string ของ role `tt_app` |
| `APP_URL` | `https://โดเมนของคุณ` (ต้องเป็น https และตรงกับโดเมนจริง) |
| `BETTER_AUTH_SECRET`, `APP_ENCRYPTION_KEY`, `CRON_SECRET` | ที่สร้างในขั้น 1 |
| `RESEND_API_KEY`, `EMAIL_FROM` | จากขั้น 3 |
| `BLOB_READ_WRITE_TOKEN` | จากขั้น 4 |

Vercel ไม่ได้สร้างตารางให้ (คำสั่ง build รันแค่ `next build`) จึงต้องทำขั้น 2 ให้เสร็จก่อนเปิดเว็บ และทุกครั้งที่ปล่อยเวอร์ชันที่มี migration ให้รัน **migrate → grants → deploy** ตามลำดับนี้

**6. ตรวจสอบหลัง deploy** (ผู้พัฒนายังไม่เคยลองบริการจริง ขั้นนี้คือการพิสูจน์)
```bash
DATABASE_URL='<string ของ tt_app>' pnpm verify:database                          # ต้องขึ้น DATABASE CHECK PASSED
APP_URL=https://โดเมนของคุณ CRON_SECRET='<secret>' pnpm smoke                     # ตรวจเว็บที่ deploy แล้ว
```
แล้วลองเองทีละอย่าง: สมัครสมาชิกจริง (อีเมลต้องมาถึง) → เข้าด้วยลิงก์เชิญของผู้ดูแล → สร้างแผนก ทีม โปรเจกต์ งาน → แนบไฟล์เล็กและไฟล์ 10–20 MB → มอบหมายงานให้อีกบัญชี (ต้องได้แจ้งเตือนและอีเมล) — รายการเต็มใน [คู่มือ ขั้น 9](docs/DEPLOYMENT_TH.md)

**ข้อควรรู้ก่อนเปิดใช้** แพ็กเกจ Vercel ต้องรองรับ cron ทุกนาที (ไม่งั้นแจ้งเตือนช้า ข้อมูลไม่หาย) · ตั้งสำรองฐานข้อมูลและลองกู้คืนก่อนเก็บข้อมูลที่เสียไม่ได้ · ถ้าอยากให้เพื่อนใช้ ลองทุกฟีเจอร์เองก่อน

---

## สิ่งที่ต้องมี (สำหรับพัฒนาในเครื่อง)
* Node.js ≥ 22, pnpm 10
* PostgreSQL ≥ 14 (ใช้ 16 ในการทดสอบทั้งหมด) ส่วน production ใช้ Neon
* สำหรับทดสอบในเบราว์เซอร์: Chromium (Playwright ตั้งให้ใช้ `/opt/pw-browsers/chromium` เปลี่ยนได้ด้วย `PLAYWRIGHT_CHROMIUM`)

## รันในเครื่อง
```bash
pnpm install
cp .env.example .env.local                 # กรอก DATABASE_URL, DATABASE_URL_UNPOOLED, BETTER_AUTH_SECRET, APP_ENCRYPTION_KEY (ดู docs/ENVIRONMENT.md)

# 1. สร้างตาราง (ในฐานะ owner ของฐานข้อมูล) 2. สร้าง role ของแอป + ให้สิทธิ์ 3. สร้างองค์กรแรก
DATABASE_URL_UNPOOLED=postgres://owner@localhost/tasks pnpm db:migrate
psql postgres://owner@localhost/tasks -c "CREATE ROLE tt_app LOGIN PASSWORD 'dev' NOSUPERUSER NOBYPASSRLS" \
     -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"
DATABASE_URL_UNPOOLED=postgres://owner@localhost/tasks pnpm bootstrap --name "Acme" --slug acme --admin-email you@example.com
#   → พิมพ์ลิงก์เชิญใช้ครั้งเดียวสำหรับผู้ดูแลคนแรก

# DATABASE_URL ใน .env.local ต้องใช้ role tt_app ไม่งั้น row-level security จะไม่มีผลกับการเชื่อมต่อของคุณ
pnpm dev                                    # http://localhost:3000   (อีเมลถูกบันทึกลง log, ไฟล์แนบเก็บที่ .data/uploads)
```

## คำสั่ง
| คำสั่ง | ใช้ทำอะไร |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm lint` / `pnpm typecheck` | ตรวจโค้ดแบบ static |
| `pnpm test:unit` | ทดสอบตรรกะล้วน |
| `pnpm test:integration` | ทดสอบกับ PostgreSQL จริงด้วย role สิทธิ์น้อย (ต้องตั้ง `TEST_DATABASE_URL`) |
| `pnpm test:e2e` | build แล้วทดสอบในเบราว์เซอร์ด้วย Playwright (Chromium) |
| `pnpm test:e2e:browsers` | ชุดเดียวกันรันทีละเบราว์เซอร์: Chromium, Firefox, WebKit (สองตัวหลังต้อง `playwright install` และ **ผู้พัฒนายังไม่เคยรัน**) |
| `pnpm load` | ทดสอบโหลดกับ production build ที่มีข้อมูลจำนวนมาก (`scripts/load-test.ts` ดู [docs/TESTING.md](docs/TESTING.md)) |
| `pnpm db:generate` / `pnpm db:migrate` | สร้าง / รัน migration |
| `pnpm bootstrap` | สร้างองค์กร (มีได้องค์กรเดียว) + ลิงก์เชิญผู้ดูแลสูงสุดคนแรก; รันซ้ำด้วย slug เดิมเพื่อออกลิงก์ใหม่ |
| `pnpm verify:database` | พิสูจน์ role และ policy บนฐานข้อมูล **ของคุณ** |
| `pnpm smoke` | ตรวจ HTTP หลัง deploy |
| `pnpm verify:attachments` | ตรวจว่าฐานข้อมูลกับที่เก็บไฟล์ตรงกัน |
| `pnpm backup:attachments --to …` / `--restore --from …` | คัดลอกไฟล์แนบไปที่เก็บที่สอง / กู้คืนกลับ (ผู้ดูแลระบบ) |
| `pnpm backup:restore-test` / `scripts/backup.sh` | ซ้อมกู้คืน / สำรองฐานข้อมูลแบบ logical |
| `pnpm rotate:key` | เข้ารหัสความลับที่เก็บไว้ใหม่หลังเปลี่ยน `APP_ENCRYPTION_KEY` |
| `pnpm auth:reset-2fa --email … \| --all --yes` | ล้าง 2FA ของคนที่ล็อกตัวเองออก หรือของทุกคนหลังเปลี่ยน `BETTER_AUTH_SECRET` (ผู้ดูแลระบบ) |
| `pnpm org export\|import` | นำข้อมูลหนึ่งองค์กรออก / เข้า (กู้คืนบางส่วน, ผู้ดูแลระบบ) |
| `pnpm privacy export\|erase --email …` | คำขอเกี่ยวกับข้อมูลส่วนตัวเมื่อเจ้าตัวใช้หน้า Security ไม่ได้ (ผู้ดูแลระบบ) |
| `pnpm docs:generate` / `pnpm docs:erd` | สร้างเอกสารที่ได้จากโค้ดใหม่ |

## โครงสร้างโปรเจกต์
```
src/domain/       กฎล้วน ๆ (workflow, graph, recurrence, time, notifications, files, retention)
src/authz/        รายการสิทธิ์ + ตัวประเมิน
src/data/         บริการที่ผูกกับองค์กร (withTenant → TenantSession)
src/db/           schema ของ Drizzle, client, RLS guard
src/integrations/ อีเมล (Resend), Discord, Google Calendar, ที่เก็บไฟล์
src/jobs/         คิว, worker, handler, ตัวตั้งเวลา
src/ops/          เครื่องมือผู้ดูแลระบบ (ตรวจไฟล์แนบ, หมุนกุญแจ, นำเข้า/ส่งออก)
src/server/       ส่วนต่อ HTTP (handle, auth, runtime, rate limit)
src/app/, src/ui/ หน้าเว็บและคอมโพเนนต์
drizzle/          migration SQL แบบมีเวอร์ชัน     scripts/   คำสั่งสำหรับผู้ดูแลระบบ
tests/            unit · integration · e2e        docs/      เอกสาร
```

## เอกสาร
| เอกสาร | เนื้อหา |
|---|---|
| [README_VPS](README_VPS.md) | **คู่มือ host บน VPS ของตัวเอง** (PostgreSQL, Caddy HTTPS, systemd, cron, สำรองข้อมูล, อัปเดต) |
| [DEPLOYMENT_TH](docs/DEPLOYMENT_TH.md) | **คู่มือ deploy ทีละขั้น (Vercel + Neon)** (Neon → Resend → Blob → Vercel → ตรวจสอบ → เปิดใช้งาน) |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | เอกสารอ้างอิง deploy: ข้อจำกัดของแผน, Vercel, Neon, Resend, Google, Blob, สคริปต์ตรวจสอบ, รายการก่อนเปิดใช้, ย้อนกลับ |
| [ENVIRONMENT](docs/ENVIRONMENT.md) | ตัวแปรทุกตัว ใช้ที่ไหน สร้างอย่างไร |
| [READINESS_REPORT](docs/READINESS_REPORT.md) | ผลที่ตรวจแล้ว ความเสี่ยงที่เหลือ สิ่งที่ต้องทำก่อนเปิดใช้ |
| [KNOWN_LIMITATIONS](docs/KNOWN_LIMITATIONS.md) | ที่ทำไม่ตรงข้อกำหนด สิ่งที่ยังไม่ตรวจกับบริการจริง เรื่องที่เจ้าของต้องตัดสินใจ |
| [SECURITY](docs/SECURITY.md) | โมเดลภัยคุกคาม มาตรการพร้อมหลักฐาน สิ่งที่พบ ขั้นตอนเมื่อเกิดเหตุ |
| [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | ตั้งค่าและดูแลองค์กร |
| [BACKUP_RESTORE](docs/BACKUP_RESTORE.md) | นโยบายสำรอง ขั้นตอนกู้คืน ผลการซ้อมที่บันทึกไว้ |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | ชั้นของระบบ วงจรของคำขอ งานเบื้องหลัง การตัดสินใจออกแบบ |
| [RBAC](docs/RBAC.md) | บทบาท ขอบเขต กฎการประเมิน ตารางสิทธิ์ (สร้างจากโค้ด) |
| [WORKFLOW](docs/WORKFLOW.md) | การเปลี่ยนสถานะ การพึ่งพากัน การแก้หลายงาน views งานซ้ำ เขตเวลา |
| [ERD](docs/ERD.md) | แผนภาพความสัมพันธ์ของตาราง (สร้างจากโค้ด 42 ตาราง) |
| [RETENTION](docs/RETENTION.md) | นโยบายการลบ การล้างข้อมูล และการเก็บ audit log |
| [MIGRATIONS](docs/MIGRATIONS.md) | วิธีเปลี่ยน schema และรายการ migration ที่ใช้แล้ว |
| [TESTING](docs/TESTING.md) | กลยุทธ์ คำสั่งที่ถูกต้อง แต่ละชุดทดสอบพิสูจน์อะไร |
| [PROVIDERS](docs/PROVIDERS.md) | เหตุผลที่เลือกแต่ละบริการ สมมติฐานเรื่องแผน ทางเลือกอื่น |
| [PHASE0_PROPOSAL](docs/PHASE0_PROPOSAL.md) | ข้อเสนอทางเทคนิคฉบับแรก (เอกสารประวัติ ภาษาไทย) |

---

## ภาพหน้าจอ

ภาพทั้งหมดแคปจากแอปที่รันจริง (production build บนเครื่องผู้พัฒนา) ด้วยข้อมูลสมมติทั้งหมด: องค์กร “สยามดีไซน์ จำกัด (ตัวอย่าง)” และชื่อคนที่ไม่มีอยู่จริง หน้าจอเป็นภาษาไทย (กดปุ่ม EN เพื่อสลับเป็นอังกฤษ) ขนาดหน้าต่าง 1280 px
ระบบมีองค์กรเดียว คนแรกที่ได้รับเชิญ (ในตัวอย่างคือ “สมชาย ใจดี”) เป็นผู้ดูแลสูงสุด จึงเห็นปุ่มลบและหน้าตั้งค่า → ทั่วไป ที่คนอื่นไม่เห็น

### เข้าสู่ระบบและสมัครสมาชิก

| เข้าสู่ระบบ | สมัครสมาชิก |
|---|---|
| ![เข้าสู่ระบบ](docs/screenshots/01-login.png) | ![สมัครสมาชิก](docs/screenshots/02-register.png) |
| **ลืมรหัสผ่าน** | **ตั้งรหัสผ่านใหม่** (จากลิงก์ในอีเมล) |
| ![ลืมรหัสผ่าน](docs/screenshots/03-forgot-password.png) | ![ตั้งรหัสผ่านใหม่](docs/screenshots/04-reset-password.png) |
| **ขอสิทธิ์เข้าใช้งาน** (มีองค์กรเดียวจึงไม่ต้องกรอกรหัสองค์กร ผู้ดูแลต้องอนุมัติ) | **ตอบรับคำเชิญ** (จากลิงก์ที่ผู้ดูแลส่งให้) |
| ![ขอสิทธิ์เข้าใช้งาน](docs/screenshots/05-join.png) | ![ตอบรับคำเชิญ](docs/screenshots/06-invite.png) |

**เมื่อผู้ดูแลปิดรับสมัครสมาชิกใหม่** หน้าสมัครบอกว่าสมัครได้เฉพาะอีเมลที่ได้รับคำเชิญ และหน้าขอสิทธิ์เข้าใช้งานกดไม่ได้

| สมัครสมาชิก (ปิดรับสมัคร) | ขอสิทธิ์เข้าใช้งาน (ปิดรับสมัคร) |
|---|---|
| ![สมัครสมาชิกเมื่อปิดรับสมัคร](docs/screenshots/02b-register-closed.png) | ![ขอสิทธิ์เข้าใช้งานเมื่อปิดรับสมัคร](docs/screenshots/05b-join-closed.png) |

### ภาพรวมและงาน

**แดชบอร์ด** จำนวนงานตามสถานะและความสำคัญ งานที่เลยกำหนด และความคืบหน้าของแต่ละโปรเจกต์

![แดชบอร์ด](docs/screenshots/07-dashboard.png)

**มุมมองรายการ** กรองตามโปรเจกต์ ผู้รับผิดชอบ ป้ายกำกับ สถานะ ความสำคัญ เปลี่ยนสถานะได้ในแถว และเลือกหลายงานเพื่อแก้พร้อมกัน

![มุมมองรายการ](docs/screenshots/08-tasks-list.png)

**มุมมองบอร์ด** แยกคอลัมน์ตามสถานะ (คอลัมน์ขวาสุดเลื่อนดูในหน้าจอจริง)

![มุมมองบอร์ด](docs/screenshots/09-tasks-board.png)

**มุมมองปฏิทิน** และ **ไทม์ไลน์** (เส้นแดงคือวันนี้ เส้นโยงคือการพึ่งพากันของงาน)

![มุมมองปฏิทิน](docs/screenshots/10-tasks-calendar.png)

![มุมมองไทม์ไลน์](docs/screenshots/11-tasks-timeline.png)

**รายละเอียดงาน** แก้หัวข้อ รายละเอียด (Markdown แบบปลอดภัย) วันที่ ผู้รับผิดชอบและผู้ร่วมรับผิดชอบ ป้ายกำกับ ฟิลด์กำหนดเอง งานย่อย

![รายละเอียดงาน](docs/screenshots/12-task-detail.png)

เลื่อนลงมาจะเป็นความคิดเห็น (กล่าวถึงคนอื่นด้วย @ ได้) และประวัติการเปลี่ยนแปลงของงาน

![ความคิดเห็นและประวัติ](docs/screenshots/12b-task-comments.png)

**งานของฉัน**, **ค้นหา** และ **งานที่ทำซ้ำ** (ระบบสร้างงานล่วงหน้าตามกำหนดเวลา)

![งานของฉัน](docs/screenshots/13-my-tasks.png)

![ค้นหา](docs/screenshots/14-search.png)

![งานที่ทำซ้ำ](docs/screenshots/15-recurring.png)

**การแจ้งเตือน** กระดิ่งมุมขวาบนแสดงรายการที่ยังไม่อ่าน กดแล้วไปที่งานนั้นได้เลย

![การแจ้งเตือน](docs/screenshots/24-notifications.png)

### ผู้ดูแลองค์กร

**สมาชิก** อนุมัติคำขอเข้าร่วม ระงับ เพิกถอน กำหนดบทบาท (แท็บคำเชิญและบทบาทอยู่ด้านบน)

![สมาชิก](docs/screenshots/16-members.png)

**โครงสร้างองค์กร** แผนก ทีม และโปรเจกต์ (โปรเจกต์ผูกกับทีมที่ร่วมงาน) ผู้ดูแลสูงสุดกด **ลบ** แผนก ทีม หรือโปรเจกต์ได้ ระบบบอกว่าอะไรจะถูกลบไปด้วย (ลบแผนกจะลบทีมในแผนกนั้นด้วย ลบโปรเจกต์จะลบงานทั้งหมดในโปรเจกต์ด้วย) และ **ต้องพิมพ์ชื่อของสิ่งที่จะลบให้ตรงก่อนปุ่มลบถึงกดได้** เซิร์ฟเวอร์ตรวจชื่อซ้ำอีกครั้งด้วย (คำสั่งลบที่ไม่แนบชื่อถูกปฏิเสธ) การลบที่กู้คืนจากหน้าจอไม่ได้อย่างอื่น (บทบาท ช่อง Discord ฟิลด์กำหนดเอง งานที่ทำซ้ำ คำเชิญ การเพิกถอนสมาชิก ไฟล์แนบ) ใช้หน้าต่างพิมพ์ชื่อแบบเดียวกัน คนที่ไม่ใช่ผู้ดูแลไม่เห็นปุ่มลบ

![โครงสร้างองค์กร](docs/screenshots/17-structure.png)

หน้าต่างยืนยันการลบ: พิมพ์ชื่อยังไม่ครบ ปุ่ม “ลบถาวร” กดไม่ได้ (ภาพบน) พิมพ์ครบแล้วปุ่มจึงใช้ได้ (ภาพล่าง)

![ยืนยันการลบ พิมพ์ชื่อยังไม่ครบ](docs/screenshots/17b-delete-confirm-typing.png)

![ยืนยันการลบ พิมพ์ชื่อครบแล้ว](docs/screenshots/17c-delete-confirm-ready.png)

**ตั้งค่า** การแจ้งเตือน, การเชื่อมต่อ (Google Calendar, Discord, สถานะงานเบื้องหลัง), ฟิลด์กำหนดเอง, ป้ายกำกับ และ **ทั่วไป** (สวิตช์เปิด/ปิดการสมัครสมาชิกใหม่ เห็นเฉพาะผู้ดูแล)

![ตั้งค่าการแจ้งเตือน](docs/screenshots/18-settings-notifications.png)

![ตั้งค่าการเชื่อมต่อ](docs/screenshots/19-settings-integrations.png)

![ฟิลด์กำหนดเอง](docs/screenshots/20-settings-custom-fields.png)

![ป้ายกำกับ](docs/screenshots/21-settings-labels.png)

สวิตช์เปิด/ปิดการสมัครสมาชิกใหม่ ตั้งค่า → ทั่วไป (ภาพบน: เปิดรับสมัคร ภาพล่าง: ปิดรับสมัคร)

![ตั้งค่าทั่วไป เปิดรับสมัคร](docs/screenshots/21b-settings-general.png)

![ตั้งค่าทั่วไป ปิดรับสมัคร](docs/screenshots/21c-settings-general-closed.png)

**บันทึกการตรวจสอบ** ใครทำอะไรเมื่อไร เก็บ 90 วัน และไม่เก็บเนื้อหาของงาน (รายการบนสุดในภาพคือการเปิด/ปิดรับสมัครจากภาพก่อนหน้า)

![บันทึกการตรวจสอบ](docs/screenshots/22-audit.png)

### บัญชีของฉัน

**ความปลอดภัย** โปรไฟล์ เปลี่ยนรหัสผ่าน เปิด 2FA ดูและเพิกถอนเซสชันที่ใช้งานอยู่ ส่งออกข้อมูลส่วนตัวและลบบัญชี

![ความปลอดภัย](docs/screenshots/23-security.png)

### บนมือถือ (กว้าง 390 px)

แคปจากหน้าต่างกว้าง 390 px (ขนาดมือถือ) ของแอปจริง หน้าไม่ล้นจอด้านข้างทุกหน้า รูปทั้งหมดใส่เป็นรูปธรรมดาทีละรูป (ไม่ใช้ตาราง HTML) เพื่อให้แสดงได้ทุกที่ที่อ่าน README

**เข้าสู่ระบบ**

![เข้าสู่ระบบบนมือถือ](docs/screenshots/27-mobile-login.png)

**แดชบอร์ด**

![แดชบอร์ดบนมือถือ](docs/screenshots/28-mobile-dashboard.png)

**รายการงาน**

![รายการงานบนมือถือ](docs/screenshots/25-mobile-tasks.png)

**รายละเอียดงาน**

![รายละเอียดงานบนมือถือ](docs/screenshots/26-mobile-task-detail.png)

**โครงสร้างองค์กร** (ปุ่มลบเห็นเฉพาะผู้ดูแล)

![โครงสร้างองค์กรบนมือถือ](docs/screenshots/29-mobile-structure.png)

**ยืนยันการลบ** ต้องพิมพ์ชื่อให้ตรงก่อนปุ่มลบจะกดได้ (ในภาพพิมพ์ยังไม่ครบ ปุ่มจึงจาง)

![ยืนยันการลบบนมือถือ](docs/screenshots/30-mobile-delete-confirm.png)

**ตั้งค่า → ทั่วไป** สวิตช์เปิด/ปิดรับสมัครสมาชิก

![ตั้งค่าทั่วไปบนมือถือ](docs/screenshots/31-mobile-settings-general.png)

**สมาชิก**

![สมาชิกบนมือถือ](docs/screenshots/32-mobile-members.png)
