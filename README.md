# تطبيق المكتب البيطري لخدمات الدواجن — Backend Foundation

منصة رقمية لمكتب بيطري متخصص في الدواجن: منتجات وأدوية ولقاحات، استشارات، فرق تطعيم،
طلبات ومخزون ومشتريات، توصيل، فوترة ودفع، دردشة وذكاء اصطناعي، تقارير وإدارة — في نظام واحد.

هذا المستودع يحتوي حالياً **المرحلة 0 والمرحلة 1**: البنية الأساسية (Multi-Tenancy، Auth،
RBAC، Audit Trail) كما اعتُمدت في `docs/decisions/`. الوحدات التالية (الكتالوج، المخزون،
الطلبات، الوصفات، ...) تُبنى بالترتيب الموثق في `01-architecture-and-decisions.md` §10،
ولا تُبنى قبل اعتماد بطاقة مواصفاتها.

**لا بيانات وهمية (Mock/Fake/Demo/Placeholder) في أي مكان من هذا المستودع.** أي شاشة أو
واجهة لا تملك تنفيذاً حقيقياً في الـ Backend لا تُبنى؛ عند غياب البيانات تُعرض
"لا توجد بيانات حالياً".

## التوثيق المعماري

اقرأ بهذا الترتيب قبل أي تعديل:

1. [`docs/decisions/01-architecture-and-decisions.md`](docs/decisions/01-architecture-and-decisions.md) — القرارات المعمارية (ADR-01..15)، مخطط النظام، الأمان، AI Governance، خارطة الطريق.
2. [`docs/decisions/02-data-model-and-workflows.md`](docs/decisions/02-data-model-and-workflows.md) — ERD الكامل، آلات الحالة لكل Workflow، كتالوج الصلاحيات.
3. [`docs/decisions/03-module-cards-foundation.md`](docs/decisions/03-module-cards-foundation.md) — بطاقات M01–M04 (Multi-Tenancy، Auth، RBAC، Audit).
4. [`docs/decisions/04-module-cards-m05-m06.md`](docs/decisions/04-module-cards-m05-m06.md) — بطاقات M05 (Files)، M06 (Notifications).

أي تغيير معماري لاحق يُضاف كملف قرار جديد في `docs/decisions/`، ولا يُعدَّل قرار سابق بصمت.

## البنية

```
backend/            NestJS API (modular monolith — see ADR-01)
  src/domain/        منطق الأعمال الصِرف: RBAC، آلات الحالة، سلسلة التدقيق، سياسات المصادقة.
                      لا يستورد من NestJS أو pg — يُختبر بلا قاعدة بيانات ولا شبكة.
  src/database/       تجمع الاتصالات، سياق المستأجر (withTenant)، مُشغّل الترحيلات.
  src/modules/        وحدات NestJS (تبدأ بـ audit وhealth؛ البقية حسب الترتيب المعتمد).
  src/common/         الحارس العام للصلاحيات، مرشّح Problem Details، التحقق من المدخلات.
  migrations/         SQL يدوي مرقّم، لا `synchronize` (ADR-05).
  test/db/            اختبارات تكامل تحتاج PostgreSQL حقيقياً (RLS، سلسلة التدقيق، بذرة RBAC).
docker/postgres/      تمهيد أدوار قاعدة البيانات (vet_migrator المالك، vet_app المقيَّد بـ RLS).
docker-compose.yml     PostgreSQL (pgvector) + Redis + MinIO للتطوير المحلي.
scripts/               فاحص اصطلاحات لا يعتمد على أي حزمة (يفشل البناء عند مسار بلا صلاحية معلنة).
```

## التشغيل محلياً

يتطلب: Node.js 22+، Docker.

```bash
cp .env.example .env        # املأ كل قيمة، لا تترك كلمات مرور فارغة
docker compose up -d
cd backend
npm install
npm run migrate             # يستخدم MIGRATION_DATABASE_URL (دور vet_migrator المالك)
npm run start:dev           # يستخدم DATABASE_URL (دور vet_app المقيَّد بـ RLS)
```

- الوثائق التفاعلية (Swagger): `http://localhost:3000/docs` (تلقائياً خارج `production`).
- فحص الصحة: `GET /health/live` و`GET /health/ready`.

## الاختبارات

```bash
npm run lint                # ESLint
npm run typecheck           # tsc --noEmit
npm run check:conventions   # يفشل إن وُجد Endpoint بلا @Public()/@RequirePermission(...)
npm test                    # اختبارات الوحدة لمنطق src/domain (لا تحتاج قاعدة بيانات)
npm run test:db             # اختبارات تكامل حقيقية: RLS، سلسلة التدقيق، بذرة الصلاحيات
                             # (تتطلب DATABASE_URL و MIGRATION_DATABASE_URL لقاعدة مُرحَّلة فعلاً)
npm run build
```

CI (`.github/workflows/ci.yml`) يشغّل كل ما سبق ضد PostgreSQL وRedis حقيقيين على كل Push/PR،
ولا يمرّ إن فشل أي منها.

## قواعد لا تُخترق (ملخص، التفاصيل في `docs/decisions/`)

- كل صلاحية تُتحقق في الـ Backend فقط؛ لا يُوثَق بأي صلاحية يدّعيها العميل (ADR الحارس العام).
- كل جدول تشغيلي معزول بـ Row-Level Security على مستوى الشركة (ADR-02).
- `audit_logs` قراءة وإضافة فقط على مستوى قاعدة البيانات؛ لا `UPDATE`/`DELETE` حتى بصلاحية مدير.
- الانتقال بين حالات أي Workflow يمرّ عبر `assertTransition` فقط؛ لا تحديث حالة مباشر في SQL.
- لا صنف يتطلب وصفة يُصرف أو يدخل `PROCESSING` بلا وصفة `APPROVED` سارية.

## المطور والمنشئ

د. ضيف الله الحسني.
