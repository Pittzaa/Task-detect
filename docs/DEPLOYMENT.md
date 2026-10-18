# การ deploy (Vercel + Neon + Resend) — เอกสารอ้างอิง

> คู่มือทีละขั้นสำหรับคนที่ deploy ครั้งแรก: [DEPLOYMENT_TH.md](DEPLOYMENT_TH.md) · ตัวแปรทั้งหมด: [ENVIRONMENT.md](ENVIRONMENT.md)
> เอกสารนี้เป็นฉบับอ้างอิง (ข้อจำกัดของแผน เหตุผล รายการตรวจ) เลขหัวข้อ §0–§10 คงเดิมเพราะเอกสารอื่นอ้างถึง

> **อ่านก่อน: อะไรที่ตรวจสอบแล้ว และอะไรที่ยังไม่ได้ตรวจสอบ**
> ทุกอย่างที่อยู่ใต้ส่วน *ฐานข้อมูล* ผ่านการทดสอบกับ PostgreSQL 16 ในเครื่องและ production build ในเครื่อง
> **ผู้พัฒนาไม่มีบัญชี Vercel, Neon, Resend, Google หรือ Vercel Blob จริง** จึงไม่เคยทดสอบการเชื่อมต่อเหล่านี้ตั้งแต่ต้นจนจบ
> ข้อความที่อธิบายหน้าจอหรือข้อจำกัดของแผนของผู้ให้บริการ เขียนจากความรู้ทั่วไปหรือข้อความจากผลค้นหา และมีป้าย **(ตรวจสอบเอง)**
> เครื่องมือที่ผู้พัฒนาใช้เปิด vercel.com และ neon.com ไม่ได้
> สคริปต์ในข้อ 8 มีไว้ให้ *คุณ* พิสูจน์การ deploy บนบริการจริงได้ในไม่กี่นาที

## 0. แผนและข้อจำกัดที่กระทบการออกแบบ (ตรวจสอบเองทุกข้อก่อนพึ่งพา)

| หัวข้อ | สิ่งที่แอปสมมติ | ทำไมสำคัญ | ทางสำรอง |
|---|---|---|---|
| **ความถี่ของ Vercel Cron** | ทุกนาที (`vercel.json`) มีรายงานว่าแผน *Hobby* รันได้แค่วันละครั้ง ส่วน *Pro* รันทุกนาทีได้ **(ตรวจสอบเอง)** | การเตือน อีเมล Discord ซิงก์ปฏิทิน และสรุปประจำวัน ถูกขับด้วย `/api/cron/tick` | ถ้าแผนรันทุกนาทีไม่ได้ ให้อัปเกรด หรือใช้ตัวตั้งเวลาภายนอกเรียก `GET /api/cron/tick` พร้อม `Authorization: Bearer $CRON_SECRET` ทุก 1–5 นาที คิวงานไม่หาย tick ที่ช้าแค่ทำให้ช้าลง ถ้าแผน *ปฏิเสธ* ตารางเวลานี้ตอน deploy ให้แก้ `vercel.json` |
| **ขนาด body ของ function** | ไฟล์ไม่เกิน **4 MB** ผ่าน function (`MAX_UPLOAD_BYTES` มีรายงานว่า function ของ Vercel ปฏิเสธ body เกิน ~4.5 MB **(ตรวจสอบเอง)**) ไฟล์ใหญ่กว่านั้นถึง **25 MB** ไปจากเบราว์เซอร์เข้า Vercel Blob โดยตรง (ขอโทเค็นอายุสั้นจาก `/attachments/direct` แล้วเซิร์ฟเวอร์ตรวจไฟล์ที่ `/attachments/direct/complete`) เปิดให้ใช้เมื่อตั้ง `BLOB_READ_WRITE_TOKEN` เท่านั้น | เส้นทางตรงนี้ **ยังไม่เคยรันกับ Blob จริง** (ดูรายการตรวจในข้อ 8) | ถ้าการตรวจในข้อ 8 ไม่ผ่าน ให้ตั้ง `DIRECT_UPLOADS=off` (ไฟล์จะจำกัดที่ 4 MB) หรือแก้ปัญหา CSP/CORS ที่พบ |
| **ระยะเวลาของ function** | route cron ประกาศ `maxDuration = 60` และทำงานเป็นช่วง ≤ 45 วินาที งานล้างข้อมูลเลื่อนตัวเองเมื่อเวลาหมด | แผนที่จำกัดเวลาสั้นกว่านี้จะตัดงานกลางคัน | งานมีสัญญาเช่า (lease) และลองใหม่ได้ ลด `maxMs` ใน `src/jobs/tick.ts` ถ้าจำเป็น |
| **การเชื่อมต่อ Neon** | `DATABASE_URL` คือ string แบบ *pooled* ธุรกรรมแบบโต้ตอบผ่านไดรเวอร์ WebSocket (`@neondatabase/serverless` `Pool`) | ทุกคำขอเปิดธุรกรรมและตั้งบริบทขององค์กรด้วย `set_config(..., true)` (มีผลเฉพาะธุรกรรมนั้น) | ดูหัวข้อ *Neon* ด้านล่าง |
| **การสำรองของ Neon** | ช่วงเวลากู้คืนย้อนหลัง (point-in-time) ขึ้นกับแผน **(ดูใน console เอง)** | ดู [BACKUP_RESTORE.md](BACKUP_RESTORE.md) | สำรองแบบ logical รายวันด้วย `scripts/backup.sh` |
| **Resend** | ยืนยันโดเมนส่งอีเมลแล้ว มีขีดจำกัดรายวันของแผนฟรี **(ตรวจสอบเอง)** | การสมัคร คำเชิญ รีเซ็ตรหัส แจ้งเตือน และสรุปประจำวัน ใช้อีเมลทั้งหมด | ตรวจขีดจำกัดของ Resend เทียบกับปริมาณที่คาดไว้ |

## 1. สิ่งที่ต้องเตรียม

* Node.js ≥ 22 และ pnpm 10 บนเครื่องที่รัน migration (เครื่องของคุณหรือ CI)
* โดเมนที่คุณควบคุมได้ (ใช้เป็น `APP_URL` และเป็นโดเมนส่งอีเมลของ Resend)
* `psql` สำหรับตั้ง role ครั้งเดียว หรือ SQL console อะไรก็ได้

## 2. Neon (ฐานข้อมูล)

1. สร้างโปรเจกต์ใน region **ที่ใกล้ region ของ function บน Vercel ที่สุด** (ทุก query ต้องจ่ายค่า latency)
2. จด connection string 2 แบบ: แบบ **pooled** (host มีคำว่า `-pooler` **(ตรวจสอบเอง)**) และแบบ **direct**
3. role เริ่มต้นของโปรเจกต์คือ **owner** ใช้สำหรับ migration, bootstrap และ backup เท่านั้น
4. สร้าง **role สำหรับแอป** (ห้ามเป็น superuser ห้ามมี `BYPASSRLS`) ใน SQL editor ในฐานะ owner:

   ```sql
   CREATE ROLE tt_app LOGIN PASSWORD '<รหัสผ่านสุ่มยาว ๆ>' NOSUPERUSER NOBYPASSRLS;
   ```

   การแยกข้อมูลระหว่างองค์กรอาศัยข้อนี้: row-level security ไม่ผูกมัด role ที่ข้ามมันได้ ใน production แอปปฏิเสธให้บริการข้อมูลองค์กร
   ผ่าน role แบบนั้น (`src/db/rls-guard.ts` → HTTP 503) รวมถึง role ที่เป็นเจ้าของตาราง และ `pnpm verify:database`
   ตรวจข้อนี้โดยตรง ให้ประกอบ connection string ของแอปจากข้อมูลของ role นี้
5. รัน migration ในฐานะ owner (string แบบ direct) แล้วให้สิทธิ์:

   ```bash
   DATABASE_URL_UNPOOLED='<owner direct string>' pnpm db:migrate
   psql '<owner direct string>' -v ON_ERROR_STOP=1 -c "$(sed 's/{{APP_ROLE}}/tt_app/g' scripts/grants.sql)"
   ```

   **รันส่วนให้สิทธิ์ (grants) ซ้ำทุกครั้งที่ปล่อยเวอร์ชันที่เพิ่มตารางหรือฟังก์ชัน** (migration ไม่ได้ให้สิทธิ์กับ role ของแอป)
6. สร้าง role ของระบบและองค์กรแรก (ยังคงเป็น owner; bootstrap ทำงานได้กับ owner ที่ไม่มี
   `BYPASSRLS` — มีเทสต์ใน `tests/integration/owner-role.test.ts`):

   ```bash
   DATABASE_URL_UNPOOLED='<owner direct string>' pnpm bootstrap --name "Acme Co" --slug acme --admin-email admin@acme.example --app-url https://tasks.example.com
   ```

   คำสั่งนี้พิมพ์ลิงก์ใช้ครั้งเดียว (อายุ 7 วัน) สำหรับผู้ดูแลคนแรก ส่วน `--slug` คือรหัสองค์กรที่สมาชิกพิมพ์ในหน้า “ขอเข้าร่วม”

**ถ้าสร้าง Neon ผ่านปุ่ม Integration ใน Vercel (Marketplace):** ตอนติดตั้ง ปิด *Auth* และ *Realtime* (แอปไม่ใช้ทั้งสองอย่าง) เท่าที่ทราบ Vercel จะใส่ `DATABASE_URL` และ `DATABASE_URL_UNPOOLED`
ที่เป็นของ **owner** ให้เองใน environment variables **(ตรวจสอบชื่อตัวแปรเองในหน้า Settings → Environment Variables)** ต้องแก้: ตั้ง `DATABASE_URL` เป็น string ของ `tt_app` และ **ลบ `DATABASE_URL_UNPOOLED` ออกจาก Vercel**
(เก็บไว้ในเครื่องคุณ) ดูขั้นตอนใน [DEPLOYMENT_TH.md](DEPLOYMENT_TH.md) ขั้น 3.1ข

**(ตรวจสอบเอง)** มี 2 พฤติกรรมของ Neon ที่ทดสอบในเครื่องไม่ได้: `set_config` ที่มีผลเฉพาะธุรกรรมยังทำงานผ่าน pooler (ควรทำงาน เพราะอยู่ในธุรกรรมเดียว)
และ Neon ให้คุณสมบัติอะไรกับ owner เริ่มต้น `pnpm verify:database` (ข้อ 8) ทดสอบข้อแรกกับบริการจริง และรายงานข้อที่สอง

## 3. Resend (อีเมล)

1. เพิ่มและยืนยันโดเมนส่งอีเมล (DNS record ที่ Resend ให้: SPF/DKIM) รอจนสถานะเป็น *Verified*
2. สร้าง API key ที่มีสิทธิ์ *ส่ง*
3. ตั้ง `RESEND_API_KEY` และ `EMAIL_FROM` (ที่อยู่บนโดเมนที่ยืนยันแล้ว)

การส่งไม่ซ้ำ (ทุกข้อความมี idempotency key ที่ได้จากการแจ้งเตือน) ถ้าล้มเหลวคิวงานลองใหม่ให้ และไม่ได้ประมวลผลอีเมลตีกลับ (ดูข้อจำกัด)

## 4. Google (ไม่บังคับ)

ใช้ OAuth client แยกกัน 2 ตัวเพื่อให้ขอสิทธิ์น้อยที่สุด ใน Google Cloud Console → *APIs & Services*:

* **client สำหรับล็อกอิน** (`GOOGLE_CLIENT_ID/SECRET`): redirect URI ที่อนุญาต `https://<host ของ APP_URL>/api/auth/callback/google`
* **client สำหรับปฏิทิน** (`GOOGLE_CALENDAR_CLIENT_ID/SECRET`): เปิด *Google Calendar API*; scope `https://www.googleapis.com/auth/calendar.events`;
  redirect URI `https://<host ของ APP_URL>/api/calendar/callback`

Google อาจกำหนดให้ยืนยันหน้า OAuth consent ก่อนผู้ใช้ที่ไม่ใช่ผู้ทดสอบจะอนุญาต scope ปฏิทินได้ **(ตรวจสอบเอง)**
การซิงก์ปฏิทินเป็น **ทางเดียว** (แอปนี้ → ปฏิทินของผู้ใช้): โค้ดไม่มีฟังก์ชันอ่าน ดังนั้นการแก้ใน Google ไม่ไหลกลับมา

## 5. Vercel Blob (ไฟล์แนบ)

สร้าง Blob store แบบ **private** เชื่อมกับโปรเจกต์ และตั้ง `BLOB_READ_WRITE_TOKEN` ออบเจ็กต์ถูกเก็บแบบ private อ่านได้เฉพาะผ่าน route ที่ยืนยันตัวตนแล้ว
`/api/orgs/:org/attachments/:id` และส่งพร้อม `Content-Disposition: attachment`, `nosniff` และ CSP แบบ sandbox โค้ดไคลเอนต์ของ Blob ผ่านการตรวจชนิดกับ SDK แล้ว
แต่ **ไม่เคยรันกับ store จริง** ส่วน store แบบไฟล์ที่ใช้ในเทสต์ใช้อินเทอร์เฟซเดียวกัน

## 6. Vercel (โฮสต์)

1. Import repository เลือก Framework preset: Next.js, Install: `pnpm install`, Build: `pnpm build` (ค่าเริ่มต้น)
2. ตั้ง environment variables จาก [ENVIRONMENT.md](ENVIRONMENT.md) สำหรับสภาพแวดล้อม **Production** Preview deployment ต้องใช้ฐานข้อมูล *แยก*
   และความลับของตัวเอง Neon branch **คัดลอกข้อมูลจากต้นทางมาด้วย** (และเท่าที่ทราบรวมถึง role ของมัน): สร้างจากฐานว่างหรือฐานที่ล้างข้อมูลแล้วและตั้งรหัสผ่าน role ใหม่ หรือใช้ project เปล่า อย่าให้ preview มีสำเนาข้อมูล production เด็ดขาด
3. `vercel.json` ลงทะเบียน cron `GET /api/cron/tick` ทุกนาที Vercel ส่ง `Authorization: Bearer $CRON_SECRET` เมื่อตั้ง `CRON_SECRET`
4. เพิ่มโดเมนและตั้ง `APP_URL` เป็นโดเมนนั้น **ก่อน** deploy ครั้งแรก (ค่านี้ถูกฝังในลิงก์อีเมล การตรวจ origin ของ CSRF และ OAuth redirect)
5. Deploy ห้ามรัน migration ในขั้น build: ให้รันโดยตั้งใจ (ข้อ 2.5) *ก่อน* ปล่อยเวอร์ชันที่ต้องใช้

ลำดับสำหรับเวอร์ชันที่มี migration: **migrate → grants → deploy** migration ใน repo นี้เป็นแบบเพิ่มอย่างเดียวและเข้ากันได้กับ build เดิม
build เก่าจึงยังทำงานได้ระหว่างสลับ endpoint ตรวจความพร้อมจะรายงาน build ที่ล้ำหน้าฐานข้อมูล (เช็ค `migrations`) แทนที่จะพังตอนใช้ครั้งแรก

## 7. โดเมน คุกกี้ และ CSRF

* คุกกี้ของ session เป็น `HttpOnly` และ `SameSite=Lax` และตั้ง `Secure` ใน production (`useSecureCookies` ตามระดับของ deployment; ผู้พัฒนาเห็นค่า `__Secure-` + `Secure` ใน production build ในเครื่อง แต่ยังไม่เคยเห็นผ่าน https จริง) การเรียก API ที่แก้ข้อมูลต้องมี header `Origin` ตรงกับ `APP_URL` ด้วย
* นโยบายความปลอดภัยของเนื้อหา (CSP) และ header ความปลอดภัยอื่นตั้งโดย `src/proxy.ts` และ `next.config.ts` ถ้ามีอะไรที่ต้อง frame แอปหรือโหลดสคริปต์ภายนอก ต้องแก้ที่นั่นอย่างตั้งใจ

## 8. พิสูจน์บนบริการจริง

รัน **ตามลำดับ** หลัง deploy ครั้งแรก ทุกคำสั่งอ่านอย่างเดียว

```bash
# 1. ฐานข้อมูลตามที่แอปเห็นจริง (connection string ของ role ที่แอปใช้)
DATABASE_URL='<runtime pooled string>' pnpm verify:database

# 2. เว็บที่ deploy แล้ว (มีชีวิต ความพร้อมรวม migration + RLS, header, การเข้าถึงโดยไม่ล็อกอิน, การปฏิเสธข้าม origin)
APP_URL=https://tasks.example.com CRON_SECRET='<secret>' pnpm smoke

# 3. ไฟล์แนบตรงกับฐานข้อมูล (หลังอัปโหลดครั้งแรก และหลังการกู้คืนทุกครั้ง)
DATABASE_URL='<runtime string>' BLOB_READ_WRITE_TOKEN='<token>' pnpm verify:attachments
```

จากนั้นลองด้วยมือ ซึ่งไม่มีสคริปต์ทำแทนได้:

* [ ] สมัครด้วยอีเมลจริง: อีเมลยืนยัน **มาถึง** (Resend) และลิงก์พาเข้าสู่ระบบได้
* [ ] เข้าในฐานะผู้ดูแลที่ bootstrap ไว้ผ่านลิงก์เชิญ สร้างแผนก ทีม โปรเจกต์ และงาน
* [ ] อัปโหลดและดาวน์โหลดไฟล์แนบ (Blob): ไฟล์เล็ก (≤ 4 MB) **และไฟล์ 10–20 MB** ไฟล์ใหญ่คือการทดสอบเดียวของเส้นทางเบราว์เซอร์ → Blob โดยตรง: เปิด console ของเบราว์เซอร์ระหว่างอัปโหลดและยืนยันว่า **ไม่มี error ของ Content-Security-Policy** สำหรับ `vercel.com/api/blob` (ถ้ามี แปลว่า host ใน `src/lib/csp.ts` ผิด — ส่ง URL ที่ถูกบล็อกมาให้ผม) มีข้อความความคืบหน้า ไฟล์ขึ้นเป็นไฟล์แนบด้วยขนาดที่ถูกต้องและดาวน์โหลดแล้วตรงกับต้นฉบับทุกไบต์ และออบเจ็กต์ใน dashboard ของ Blob เป็น **private**
* [ ] มอบหมายงานให้บัญชีที่สอง: แจ้งเตือนในแอปและอีเมลมาถึง (พิสูจน์ว่า cron tick ทำงาน — ถ้าไม่ ดู `Settings → Job health`)
* [ ] เพิ่ม Discord webhook (Settings) ส่งเหตุการณ์ทดสอบ ยืนยันว่าข้อความมาถึง และ `@everyone` ในชื่องาน **ไม่** กลายเป็นการ mention
* [ ] เชื่อม Google Calendar ตั้งวันครบกำหนดให้งาน ยืนยันว่ามีอีเวนต์ **หนึ่ง** รายการ เปลี่ยนวันที่ ยืนยันว่าอีเวนต์ย้ายที่ ไม่ซ้ำ
* [ ] เปิด 2FA ออกจากระบบแล้วเข้าใหม่ด้วยรหัสและด้วย backup code
* [ ] ถ้าตั้ง `SENTRY_DSN`: ทำให้เกิด error ฝั่งเซิร์ฟเวอร์หนึ่งครั้ง (ต้องเป็น 500 ที่ไม่คาดคิด ไม่ใช่ 4xx) เช่น ชี้ `DATABASE_URL` ไปพอร์ตที่ปิดชั่วคราวใน preview deployment และยืนยันว่า **มีเหตุการณ์ที่ลบข้อมูลสำคัญแล้ว 1 รายการ** ใน tracker พร้อม request id จาก header ของ response โค้ดส่งเคยรันกับตัวจำลอง HTTPS ในเครื่อง (ดู [TESTING.md](TESTING.md#error-reporting-checked-in-the-real-server)) จนกว่าขั้นนี้ผ่าน การที่ Sentry/GlitchTip **จริง** ยอมรับเหตุการณ์ถือว่ายังไม่ได้ตรวจ
* [ ] สั่งสำรองและกู้คืนเข้าฐานข้อมูลชั่วคราวตาม [BACKUP_RESTORE.md](BACKUP_RESTORE.md)

## 9. รายการก่อนเปิดใช้งาน

**ตัวบล็อก** (อย่าเปิดจนกว่าจะติ๊กครบ):

- [ ] `pnpm verify:database` ผ่านกับ role ของแอปบน production
- [ ] `pnpm smoke` ผ่านกับ URL ของ production รวมถึงความพร้อม (`status: ok`)
- [ ] cron tick ทำงานตามความถี่ที่เลือก และ `Job health` ไม่มีงานที่ตายหรือค้าง
- [ ] มีการสำรอง **จริง** *และกู้คืนจากมันสำเร็จบนแผนของคุณแล้ว* (การซ้อมในเครื่องพิสูจน์ขั้นตอน ไม่ใช่บริการของผู้ให้บริการคุณ)
- [ ] ตรวจช่วง point-in-time restore ของ Neon และข้อจำกัด cron ของ Vercel เทียบกับแผนที่คุณจ่ายจริงแล้ว
- [ ] ยืนยันโดเมน Resend แล้ว และอีเมลจริงมาถึงกล่องจดหมาย
- [ ] `APP_ENCRYPTION_KEY` และ `BETTER_AUTH_SECRET` เก็บใน password manager แยกจากที่ deploy
- [ ] Preview deployment เข้าถึงฐานข้อมูล production ไม่ได้
- [ ] มีอย่างน้อยสองคนที่ดูแลองค์กรได้ (ระบบกันไม่ให้ล็อกผู้ดูแลคนสุดท้ายออก แต่มีคนที่สองจริง ๆ คือหลักประกันที่แท้จริง)

**แนะนำอย่างยิ่ง:**

- [ ] ตัวเฝ้าระวังเรียก `/api/health/ready` (พร้อม bearer secret) ทุก 1–5 นาทีและแจ้งเตือนเมื่อไม่ใช่ 200
- [ ] ระบบรวบรวม log / แจ้งเตือนสำหรับบรรทัดที่มี `"level":50` และ `"job queue needs attention"`
- [ ] `pnpm audit --prod` สะอาด (ตอนปล่อยเวอร์ชันสะอาด รันซ้ำก่อนเปิดใช้)
- [ ] ผู้รับผิดชอบบริการอ่านความเสี่ยงที่ยอมรับไว้ใน [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) แล้ว
- [ ] เข้าใจว่า `BETTER_AUTH_SECRET` เปลี่ยนทีหลังไม่ได้โดยไม่ทำให้ 2FA ของทุกคนใช้ไม่ได้ (กู้ด้วย `pnpm auth:reset-2fa` ดู [ENVIRONMENT.md](ENVIRONMENT.md))

## 10. ย้อนกลับ

* **แอป:** promote deployment ก่อนหน้าใน Vercel (ทันที) migration เป็นแบบเพิ่มอย่างเดียว build เดิมจึงยังทำงานกับฐานข้อมูลที่ migrate แล้ว
* **ฐานข้อมูล:** migration ไปข้างหน้าอย่างเดียว ถ้าต้องยกเลิก migration ที่เสีย ให้เขียน migration ใหม่ไปข้างหน้า ถ้าเกิดหายนะให้กู้จากสำรอง ([BACKUP_RESTORE.md](BACKUP_RESTORE.md))
* **หมุนกุญแจผิดพลาด:** ใส่กุญแจเดิมกลับใน `APP_ENCRYPTION_KEY_PREVIOUS` ระบบไม่เขียนทับอะไรเลยถ้าถอดรหัสไม่ได้
