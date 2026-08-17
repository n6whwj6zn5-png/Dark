# DARK SHOP

نظام DARK لاستقبال طلبات منتجات SHEIN من الزبائن وإدارتها من لوحة Admin.

## الملفات
- `customer.html` واجهة الزبون.
- `admin.html` لوحة الأدمن.
- `server.js` السيرفر وواجهات API.
- `render.yaml` إعداد Render مع PostgreSQL.

## التشغيل على Render
1. اربط GitHub مع Render.
2. أنشئ Web Service من هذا المستودع.
3. Render سيقرأ `render.yaml` عند استخدام Blueprint، أو أدخل:
   - Build: `npm install`
   - Start: `npm start`
4. عيّن `ADMIN_PASSWORD` في Environment Variables.

> قاعدة البيانات المجانية في Render مناسبة للتجربة فقط وتنتهي بعد 30 يوماً؛ للاستخدام التجاري المستمر تحتاج ترقية قاعدة البيانات.
