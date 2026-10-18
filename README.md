# Task Tracker — ระบบติดตามงานสำหรับองค์กร

ระบบติดตามงานหลายองค์กร (แผนก → ทีม → โปรเจกต์ → งาน) สร้างด้วย **Next.js 16 / React 19 / TypeScript**, ฐานข้อมูล **Neon PostgreSQL**, โฮสต์บน **Vercel**, ส่งอีเมลด้วย **Resend**
รองรับภาษาไทย (ค่าเริ่มต้น) และอังกฤษ แยกข้อมูลแต่ละองค์กรเด็ดขาดสองชั้น (ในโค้ด **และ** ด้วย row-level security ของ PostgreSQL) สิทธิ์แบบกำหนดขอบเขต (องค์กร/แผนก/ทีม/โปรเจกต์)
มุมมอง List / Board / ปฏิทิน / Timeline / Dashboard / งานของฉัน, ค้นหา, views ที่บันทึกได้, custom fields, แก้หลายงานพร้อมกัน, งานซ้ำ (recurring),
แจ้งเตือน (ในแอป อีเมล Discord), ซิงก์ Google Calendar ทางเดียว, ไฟล์แนบแบบปิดไม่เป็นสาธารณะ (สูงสุด 25 MB เมื่อตั้งค่า Vercel Blob), Markdown แบบปลอดภัยในคอมเมนต์และคำอธิบาย,
audit log 90 วัน, งานเบื้องหลังที่ไม่หาย, อัปเดตหน้าจออัตโนมัติ, ส่งออกข้อมูลส่วนตัวและลบบัญชี, ส่งออก/นำเข้าทีละองค์กร, ล็อกอินด้วย 2FA

> **สถานะ: พร้อมให้ทดลอง deploy แต่ยังไม่เคยขึ้นบริการจริงที่ไหนเลย** ทุกอย่างสร้างและทดสอบกับ PostgreSQL 16 ในเครื่องและ production build ในเครื่อง
> **ไม่เคยเชื่อมต่อ** Vercel, Neon, Resend, Google, Discord และ Vercel Blob จริง อ่าน [docs/READINESS_REPORT.md](docs/READINESS_REPORT.md) (อะไรตรวจแล้ว อะไรยังไม่ได้ตรวจ สิ่งที่ต้องทำก่อนเปิดใช้)
> และ [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) ก่อนเปิดให้คนอื่นใช้

---

## ติดตั้งและ deploy (เริ่มที่นี่)

ใช้ **Vercel** (โฮสต์ + ตัวตั้งเวลา + ที่เก็บไฟล์แนบ Blob) + **Neon** (ฐานข้อมูล) + **Resend** (ส่งอีเมล)
คู่มือทีละขั้นละเอียดพร้อมเหตุผล: **[docs/DEPLOYMENT_TH.md](docs/DEPLOYMENT_TH.md)** · เอกสารอ้างอิง: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · ตัวแปรทั้งหมด: [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)

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

# 2.3 สร้างองค์กรแรก (พิมพ์ลิงก์เชิญใช้ครั้งเดียวสำหรับผู้ดูแลคนแรก)
DATABASE_URL_UNPOOLED='<owner direct>' pnpm bootstrap --name "ชื่อองค์กร" --slug acme --admin-email you@example.com --app-url https://โดเมนของคุณ
```
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
| `pnpm bootstrap` | สร้างองค์กร + ลิงก์เชิญผู้ดูแลคนแรก (ผู้ดูแลระบบ) |
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
| [DEPLOYMENT_TH](docs/DEPLOYMENT_TH.md) | **คู่มือ deploy ทีละขั้น** (Neon → Resend → Blob → Vercel → ตรวจสอบ → เปิดใช้งาน) |
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
