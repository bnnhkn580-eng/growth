require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
app.use(cors());

// ============================================================================
// 1. FIREBASE INITIALIZATION (`proinvast`)
// ============================================================================
let db = null;
let firebaseError = null;

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'proinvast_admin_2026';
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_U2nWOcYMlSq4ja';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '14RSSW5WKKVtmoX2zGJWcOjh';

function parseServiceAccount(raw) {
  if (!raw) return null;
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (parsed.private_key && typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const sa = parseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT);
    const fbApp = admin.initializeApp({ credential: admin.credential.cert(sa) }, 'proinvastLiveApp');
    db = fbApp.firestore();
  } else {
    firebaseError = 'FIREBASE_SERVICE_ACCOUNT environment variable missing';
  }
} catch (err) {
  firebaseError = err.message;
}

function ensureDb(res) {
  if (!db) {
    res.status(400).json({
      success: false,
      uiPosition: 'center',
      message: 'Koi Firebase DB configured nahi hai'
    });
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'] || req.body?.adminKey;
  if (!provided || provided !== ADMIN_SECRET) {
    return res.status(403).json({
      success: false,
      uiPosition: 'center',
      message: 'Unauthorized admin key'
    });
  }
  next();
}

function hashSecret(val) {
  return crypto.createHash('sha256').update(String(val)).digest('hex');
}

// VIP Tiers: 280->1, 3800->2, 8900->3, 13000->4, 50000->5, 200000->6, 500000->7, 1000000->8[span_0](start_span)[span_0](end_span)
function calcVipLevel(totalInvestment) {
  const amt = Number(totalInvestment || 0);
  if (amt >= 1000000) return 8;
  if (amt >= 500000) return 7;
  if (amt >= 200000) return 6;
  if (amt >= 50000) return 5;
  if (amt >= 13000) return 4;
  if (amt >= 8900) return 3;
  if (amt >= 3800) return 2;
  if (amt >= 280) return 1;
  return 0;
}

// ============================================================================
// 2. HEALTH & LIVE USER SYNC[span_1](start_span)[span_1](end_span)[span_2](start_span)[span_2](end_span)
// ============================================================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    uiPosition: 'center',
    service: 'ProInvast Complete API',
    project: 'proinvast',
    dbConnected: Boolean(db),
    firebaseError
  });
});

app.get('/api/live-sync/:userId', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const uid = String(req.params.userId);
    const [codeSnap, siteSnap, cfgSnap, userSnap, prodSnap, ordSnap, tktSnap] = await Promise.all([
      db.collection('live_user_code').doc('active').get(),
      db.collection('user_site_link').doc('active').get(),
      db.collection('app_config').doc('main').get(),
      db.collection('users').doc(uid).get(),
      db.collection('products').get(),
      db.collection('orders').where('userId', '==', uid).get(),
      db.collection('tickets').where('userId', '==', uid).get()
    ]);

    let safeUser = null;
    if (userSnap.exists) {
      safeUser = { id: userSnap.id, ...userSnap.data() };
      delete safeUser.passwordHash;
      delete safeUser.withdrawPasswordHash;
    }

    const codeMeta = codeSnap.exists
      ? {
          version: codeSnap.data().version,
          updatedAt: codeSnap.data().updatedAt,
          forceReload: Boolean(codeSnap.data().forceReload)
        }
      : { version: 'v0', updatedAt: null, forceReload: false };

    const siteInfo = siteSnap.exists
      ? {
          url: siteSnap.data().url || '',
          number: siteSnap.data().number || '',
          version: siteSnap.data().version || 'v0',
          autoUpdate: Boolean(siteSnap.data().autoUpdate),
          updatedAt: siteSnap.data().updatedAt || null
        }
      : { url: '', number: '', version: 'v0', autoUpdate: false, updatedAt: null };

    return res.json({
      success: true,
      syncedAt: new Date().toISOString(),
      codeMeta,
      siteInfo,
      config: cfgSnap.exists ? cfgSnap.data() : {},
      user: safeUser,
      products: prodSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      myProducts: ordSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      tickets: tktSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 3. HOSTING SITE LINK + PASS + NUMBER + AUTO UPDATE[span_3](start_span)[span_3](end_span)[span_4](start_span)[span_4](end_span)
// ============================================================================
app.post('/api/admin/user-site/connect', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const {
      url,
      link,
      pass = '',
      password = '',
      number = '',
      autoUpdate = true,
      forceReload = true,
      note = ''
    } = req.body;

    const cleanUrl = String(url || link || '').trim();
    const cleanPass = String(pass || password || '').trim();
    const cleanNumber = String(number || '').trim();

    if (!cleanUrl) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Hosting site ka link (url) zaroori hai'
      });
    }

    const version = 'site_' + Date.now();
    const siteDoc = {
      url: cleanUrl,
      pass: cleanPass,
      number: cleanNumber,
      version,
      note: String(note),
      autoUpdate: Boolean(autoUpdate),
      forceReload: Boolean(forceReload),
      updatedAt: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('user_site_link').doc('active').set(siteDoc, { merge: true });
    await db.collection('user_site_link_history').doc(version).set(siteDoc);

    await db.collection('live_user_code').doc('active').set(
      {
        version,
        sourceUrl: cleanUrl,
        number: cleanNumber,
        forceReload: Boolean(forceReload),
        updatedAt: siteDoc.updatedAt
      },
      { merge: true }
    );

    const baseHost = `${req.protocol}://${req.get('host')}`;

    return res.json({
      success: true,
      uiPosition: 'center',
      message: `Hosting site connect aur update ho gayi (${version})`,
      version,
      url: cleanUrl,
      number: cleanNumber,
      passConfigured: Boolean(cleanPass),
      liveLink: cleanUrl,
      liveFeedEndpoint: `${baseHost}/api/user-site/live`,
      updatedAt: siteDoc.updatedAt
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/user-site/link', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('user_site_link').doc('active').get();
    const baseHost = `${req.protocol}://${req.get('host')}`;
    if (!snap.exists) {
      return res.json({
        success: true,
        connected: false,
        url: '',
        number: '',
        version: 'v0',
        liveFeedEndpoint: `${baseHost}/api/user-site/live`
      });
    }
    const d = snap.data();
    return res.json({
      success: true,
      connected: Boolean(d.url),
      url: d.url || '',
      number: d.number || '',
      version: d.version || 'v0',
      autoUpdate: Boolean(d.autoUpdate),
      forceReload: Boolean(d.forceReload),
      updatedAt: d.updatedAt || null,
      liveFeedEndpoint: `${baseHost}/api/user-site/live`
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/user-site/live', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const [siteSnap, codeSnap] = await Promise.all([
      db.collection('user_site_link').doc('active').get(),
      db.collection('live_user_code').doc('active').get()
    ]);

    const site = siteSnap.exists ? siteSnap.data() : {};
    const code = codeSnap.exists ? codeSnap.data() : {};

    return res.json({
      success: true,
      url: site.url || '',
      number: site.number || '',
      version: site.version || code.version || 'v0',
      autoUpdate: Boolean(site.autoUpdate),
      forceReload: Boolean(site.forceReload ?? code.forceReload),
      updatedAt: site.updatedAt || code.updatedAt || null,
      html: code.html || '',
      css: code.css || '',
      js: code.js || ''
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/user-site/sync-from-host', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const siteSnap = await db.collection('user_site_link').doc('active').get();
    if (!siteSnap.exists || !siteSnap.data().url) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Pehle hosting site link connect karein'
      });
    }

    const site = siteSnap.data();
    const { pass = '', number = '' } = req.body || {};

    if (site.pass && String(pass || '').trim() !== String(site.pass).trim()) {
      return res.status(403).json({
        success: false,
        uiPosition: 'center',
        message: 'Galat pass hai'
      });
    }

    if (site.number && number && String(number).trim() !== String(site.number).trim()) {
      return res.status(403).json({
        success: false,
        uiPosition: 'center',
        message: 'Galat number hai'
      });
    }

    const hostRes = await fetch(site.url);
    const fetchedBody = await hostRes.text();
    const nextVersion = 'sync_' + Date.now();
    const nowIso = new Date().toISOString();

    await db.collection('live_user_code').doc('active').set(
      {
        version: nextVersion,
        sourceUrl: site.url,
        number: site.number || '',
        html: fetchedBody,
        forceReload: true,
        updatedAt: nowIso
      },
      { merge: true }
    );

    await db.collection('user_site_link').doc('active').set(
      {
        version: nextVersion,
        lastSyncedAt: nowIso,
        updatedAt: nowIso
      },
      { merge: true }
    );

    return res.json({
      success: true,
      uiPosition: 'center',
      message: `Hosting site se automatic update sync ho gaya (${nextVersion})`,
      version: nextVersion,
      url: site.url,
      number: site.number || '',
      updatedAt: nowIso
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 4. ADMIN FULL USER CODE UPDATE & LIVE FETCH[span_5](start_span)[span_5](end_span)[span_6](start_span)[span_6](end_span)
// ============================================================================
app.post('/api/admin/user-code/publish', requireAdmin, express.json({ limit: '10mb' }), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { html = '', css = '', js = '', files = {}, note = '', forceReload = true } = req.body;
    if (!html && !css && !js && (!files || Object.keys(files).length === 0)) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Update ke liye html, css, js ya files zaroori hai'
      });
    }

    const version = 'v_' + Date.now();
    const bundle = {
      version,
      html: String(html),
      css: String(css),
      js: String(js),
      files: typeof files === 'object' && files !== null ? files : {},
      note: String(note),
      forceReload: Boolean(forceReload),
      updatedAt: new Date().toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('live_user_code').doc('active').set(bundle, { merge: true });
    await db.collection('live_user_code_history').doc(version).set(bundle);

    return res.json({
      success: true,
      uiPosition: 'center',
      message: `User code full update publish ho gaya (${version})`,
      version,
      updatedAt: bundle.updatedAt
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/user-code/live', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('live_user_code').doc('active').get();
    if (!snap.exists) {
      return res.json({
        success: true,
        published: false,
        code: { version: 'v0', html: '', css: '', js: '', files: {}, forceReload: false }
      });
    }
    return res.json({ success: true, published: true, code: snap.data() });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 5. AUTH: REGISTER & LOGIN (PHONE, PASS, WITHDRAW PASS, INVITE / NONE)[span_7](start_span)[span_7](end_span)
// ============================================================================
app.post('/api/auth/register', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const {
      phone,
      password,
      withdrawPassword,
      inviteCode,
      fromReferralLink = false,
      realName = '',
      bankName = '',
      bankAccount = ''
    } = req.body;

    if (!phone || !password || !withdrawPassword) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Phone number, password aur withdraw password zaroori hai'
      });
    }

    const cleanPhone = String(phone).trim();
    const dup = await db.collection('users').where('phone', '==', cleanPhone).limit(1).get();
    if (!dup.empty) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Yeh phone number pehle se registered hai'
      });
    }

    const userId = String(Math.floor(1000000 + Math.random() * 9000000));
    const finalInvite = fromReferralLink
      ? String(inviteCode || 'NONE').trim() || 'NONE'
      : String(inviteCode || 'NONE').trim() || 'NONE';

    const userDoc = {
      userId,
      uid: userId,
      phone: cleanPhone,
      passwordHash: hashSecret(password),
      withdrawPasswordHash: hashSecret(withdrawPassword),
      inviteCode: finalInvite,
      myInviteCode: 'INV' + userId,
      realName: String(realName).trim(),
      bankName: String(bankName).trim(),
      bankAccount: String(bankAccount).trim(),
      chargedBalance: 0,
      withdrawalBalance: 0,
      totalInvestment: 0,
      totalRecharge: 0,
      totalWithdraw: 0,
      vipLevel: 0,
      isActive: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('users').doc(userId).set(userDoc);

    const safeUser = { ...userDoc };
    delete safeUser.passwordHash;
    delete safeUser.withdrawPasswordHash;

    return res.status(201).json({
      success: true,
      uiPosition: 'center',
      message: 'Registration successful! Account ban gaya hai.',
      userId,
      inviteCode: finalInvite,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/auth/login', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        uiPosition: 'center',
        message: 'Phone number aur password daalein'
      });
    }

    const snap = await db.collection('users').where('phone', '==', String(phone).trim()).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ success: false, uiPosition: 'center', message: 'User nahi mila' });
    }

    const doc = snap.docs[0];
    const data = doc.data();
    if (data.passwordHash !== hashSecret(password)) {
      return res.status(401).json({ success: false, uiPosition: 'center', message: 'Galat password hai' });
    }

    await db.collection('users').doc(doc.id).set({ isActive: true }, { merge: true });

    const safeUser = { id: doc.id, ...data };
    delete safeUser.passwordHash;
    delete safeUser.withdrawPasswordHash;

    return res.json({
      success: true,
      uiPosition: 'center',
      message: 'Login successful!',
      userId: doc.id,
      user: safeUser
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 6. PROMO CODES[span_8](start_span)[span_8](end_span)
// ============================================================================
app.post('/api/admin/promo/create', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const {
      code,
      rewardAmount,
      balanceTarget = 'withdrawalBalance',
      expiresAt = null,
      maxUses = 0,
      allowedUserIds = [],
      requiredVipLevel = 0,
      minPurchasePrice = 0
    } = req.body;

    const cleanCode = String(code || '').trim().toUpperCase();
    const amt = Number(rewardAmount || 0);
    if (!cleanCode || amt <= 0) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'Valid code aur amount zaroori hai' });
    }

    const promo = {
      code: cleanCode,
      rewardAmount: amt,
      balanceTarget: balanceTarget === 'chargedBalance' ? 'chargedBalance' : 'withdrawalBalance',
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      maxUses: Number(maxUses || 0),
      usedCount: 0,
      usedBy: [],
      allowedUserIds: Array.isArray(allowedUserIds) ? allowedUserIds.map(String) : [],
      requiredVipLevel: Number(requiredVipLevel || 0),
      minPurchasePrice: Number(minPurchasePrice || 0),
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('promo_codes').doc(cleanCode).set(promo, { merge: true });
    return res.json({ success: true, uiPosition: 'center', message: `Promo ${cleanCode} create ho gaya`, promo });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/promo/claim', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { userId, code } = req.body;
    const cleanCode = String(code || '').trim().toUpperCase();
    if (!userId || !cleanCode) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'User ID aur promo code daalein' });
    }

    let claimedAmount = 0;

    await db.runTransaction(async (tx) => {
      const pRef = db.collection('promo_codes').doc(cleanCode);
      const uRef = db.collection('users').doc(String(userId));
      const bRef = db.collection('bills').doc();

      const pSnap = await tx.get(pRef);
      if (!pSnap.exists) throw new Error('Promo code valid nahi hai');
      const p = pSnap.data();

      if (p.expiresAt && Date.now() > new Date(p.expiresAt).getTime()) {
        throw new Error('Promo code expire ho chuka hai');
      }
      if (Number(p.maxUses || 0) > 0 && Number(p.usedCount || 0) >= Number(p.maxUses)) {
        throw new Error('Promo code ki limit khatam ho gayi hai');
      }

      const usedBy = Array.isArray(p.usedBy) ? p.usedBy : [];
      if (usedBy.includes(String(userId))) {
        throw new Error('Aap yeh promo code pehle hi claim kar chuke hain');
      }

      const allowed = Array.isArray(p.allowedUserIds) ? p.allowedUserIds : [];
      if (allowed.length > 0 && !allowed.includes(String(userId))) {
        throw new Error('Yeh promo code sirf selected users ke liye hai');
      }

      const uSnap = await tx.get(uRef);
      const u = uSnap.exists ? uSnap.data() : {};
      if (Number(p.requiredVipLevel || 0) > 0 && Number(u.vipLevel || 0) < Number(p.requiredVipLevel)) {
        throw new Error(`Is promo ke liye VIP ${p.requiredVipLevel} zaroori hai`);
      }
      if (Number(p.minPurchasePrice || 0) > 0 && Number(u.totalInvestment || 0) < Number(p.minPurchasePrice)) {
        throw new Error(`Is promo ke liye kam se kam ₹${p.minPurchasePrice} investment zaroori hai`);
      }

      claimedAmount = Number(p.rewardAmount || 0);
      const field = p.balanceTarget === 'chargedBalance' ? 'chargedBalance' : 'withdrawalBalance';
      const prevBal = Number(u[field] || 0);

      tx.set(uRef, { userId: String(userId), [field]: prevBal + claimedAmount }, { merge: true });
      tx.set(pRef, { usedCount: Number(p.usedCount || 0) + 1, usedBy: [...usedBy, String(userId)] }, { merge: true });
      tx.set(bRef, {
        userId: String(userId),
        type: 'Promo Code',
        amount: `+₹${claimedAmount.toFixed(2)}`,
        code: cleanCode,
        status: 'Success',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      uiPosition: 'center',
      message: `Promo ${cleanCode} claim ho gaya! ₹${claimedAmount.toFixed(2)} add ho gaye.`,
      credited: claimedAmount
    });
  } catch (err) {
    return res.status(400).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 7. PRODUCTS, STOCK COPIES & BUY -> VIEW PRODUCT / MY PRODUCT[span_9](start_span)[span_9](end_span)[span_10](start_span)[span_10](end_span)
// ============================================================================
app.post('/api/admin/products/add', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const {
      id,
      name,
      image = '',
      vipLevel = 0,
      price,
      dailyIncome,
      durationDays = 2,
      payoutInterval = 'daily',
      isLimited = false,
      totalCopies = null
    } = req.body;

    if (!name || Number(price) <= 0) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'Product name aur valid price zaroori hai' });
    }

    const prodId = id ? String(id) : 'PROD_' + Date.now();
    const lim = Boolean(isLimited) || (totalCopies !== null && totalCopies !== undefined && Number(totalCopies) > 0);
    const copies = lim ? Number(totalCopies || 0) : null;

    const prod = {
      id: prodId,
      name: String(name),
      image: String(image),
      vipLevel: Number(vipLevel || 0),
      price: Number(price),
      dailyIncome: Number(dailyIncome || 0),
      durationDays: Number(durationDays || 2),
      payoutInterval: String(payoutInterval || 'daily'),
      isLimited: lim,
      remainingCopies: copies,
      totalCopies: copies,
      totalBuyCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('products').doc(prodId).set(prod, { merge: true });
    return res.json({ success: true, uiPosition: 'center', message: 'Product add ho gaya', product: prod });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/admin/products/remove', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'productId zaroori hai' });
    }
    await db.collection('products').doc(String(productId)).delete();
    return res.json({ success: true, uiPosition: 'center', message: 'Product remove ho gaya' });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('products').get();
    const list = snap.docs.map((d) => {
      const p = d.data();
      const soldOut = Boolean(p.isLimited) && Number(p.remainingCopies || 0) <= 0;
      return {
        id: d.id,
        ...p,
        soldOut,
        soldOutMessage: soldOut ? 'Product khatam ho gaya hai koi or product buy karo thank you' : ''
      };
    });
    return res.json({ success: true, products: list });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/products/buy', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { userId, productId, copies = 1 } = req.body;
    const qty = Math.max(1, Number(copies || 1));
    if (!userId || !productId) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'userId aur productId zaroori hai' });
    }

    const orderId = 'ORD_' + Date.now() + '_' + Math.floor(100 + Math.random() * 900);
    let createdOrder = null;
    let newVip = 0;

    await db.runTransaction(async (tx) => {
      const pRef = db.collection('products').doc(String(productId));
      const uRef = db.collection('users').doc(String(userId));
      const oRef = db.collection('orders').doc(orderId);
      const bRef = db.collection('bills').doc();

      const pSnap = await tx.get(pRef);
      if (!pSnap.exists) throw new Error('Product nahi mila');
      const prod = pSnap.data();

      if (prod.isLimited && Number(prod.remainingCopies || 0) < qty) {
        throw new Error('Product khatam ho gaya hai koi or product buy karo thank you');
      }

      const totalCost = Number(prod.price || 0) * qty;
      const uSnap = await tx.get(uRef);
      const u = uSnap.exists ? uSnap.data() : {};
      const charged = Number(u.chargedBalance || 0);
      if (charged < totalCost) throw new Error('Charged balance kam hai, pehle recharge karein');

      const newInvest = Number(u.totalInvestment || 0) + totalCost;
      newVip = Math.max(Number(u.vipLevel || 0), calcVipLevel(newInvest));
      const durationDays = Number(prod.durationDays || 2);
      const scheduledPayoutAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

      const pPatch = { totalBuyCount: Number(prod.totalBuyCount || 0) + qty };
      if (prod.isLimited) {
        pPatch.remainingCopies = Number(prod.remainingCopies || 0) - qty;
      }

      tx.set(pRef, pPatch, { merge: true });
      tx.set(
        uRef,
        {
          chargedBalance: charged - totalCost,
          totalInvestment: newInvest,
          vipLevel: newVip,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      createdOrder = {
        id: orderId,
        orderId,
        userId: String(userId),
        productId: String(productId),
        productName: prod.name || 'Product',
        image: prod.image || '',
        price: totalCost,
        copies: qty,
        dailyIncome: Number(prod.dailyIncome || 0),
        durationDays,
        payoutInterval: prod.payoutInterval || 'daily',
        scheduledPayoutAt,
        payoutCredited: false,
        status: 'Active',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };

      tx.set(oRef, createdOrder);
      tx.set(bRef, {
        userId: String(userId),
        type: 'Buy Product',
        amount: `-₹${totalCost.toFixed(2)}`,
        status: 'Success',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      uiPosition: 'center',
      message: 'Product buy ho gaya! View Product ya My Product check karein.',
      orderId,
      vipLevel: newVip,
      order: createdOrder,
      actions: [
        { label: 'View Product', target: 'view_product', productId: String(productId) },
        { label: 'My Product', target: 'my_product', orderId }
      ]
    });
  } catch (err) {
    return res.status(400).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/my-products/:userId', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('orders').where('userId', '==', String(req.params.userId)).get();
    return res.json({ success: true, orders: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/orders/process-due', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const now = Date.now();
    const snap = await db.collection('orders').where('payoutCredited', '==', false).get();
    let processedCount = 0;

    for (const doc of snap.docs) {
      const ord = doc.data();
      const dueMs = ord.scheduledPayoutAt ? new Date(ord.scheduledPayoutAt).getTime() : 0;
      if (dueMs > 0 && now >= dueMs) {
        const gain = Number(ord.dailyIncome || 0) * Number(ord.durationDays || 1) * Number(ord.copies || 1);
        await db.runTransaction(async (tx) => {
          const oSnap = await tx.get(doc.ref);
          if (!oSnap.exists || oSnap.data().payoutCredited) return;

          const uRef = db.collection('users').doc(String(ord.userId));
          const uSnap = await tx.get(uRef);
          const curW = uSnap.exists ? Number(uSnap.data().withdrawalBalance || 0) : 0;

          tx.set(uRef, { withdrawalBalance: curW + gain }, { merge: true });
          tx.set(doc.ref, { payoutCredited: true, status: 'Completed', creditedAmount: gain }, { merge: true });
        });
        processedCount += 1;
      }
    }

    return res.json({ success: true, uiPosition: 'center', message: `${processedCount} payouts credit ho gaye`, processedCount });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 8. RECHARGE & WITHDRAW[span_11](start_span)[span_11](end_span)
// ============================================================================
async function creditRecharge({ userId, amount, txId }) {
  const txRef = db.collection('recharges').doc(String(txId));
  const userRef = db.collection('users').doc(String(userId));
  const billRef = db.collection('bills').doc();

  await db.runTransaction(async (tx) => {
    const ex = await tx.get(txRef);
    if (ex.exists) return;

    const uSnap = await tx.get(userRef);
    const u = uSnap.exists ? uSnap.data() : {};
    const prevCharged = Number(u.chargedBalance || 0);
    const prevRecharge = Number(u.totalRecharge || 0);

    tx.set(
      userRef,
      {
        userId: String(userId),
        chargedBalance: prevCharged + Number(amount),
        totalRecharge: prevRecharge + Number(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );

    tx.set(txRef, {
      txId: String(txId),
      userId: String(userId),
      amount: Number(amount),
      status: 'Success',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    tx.set(billRef, {
      userId: String(userId),
      type: 'Recharge',
      amount: `+₹${Number(amount).toFixed(2)}`,
      status: 'Success',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });
}

app.post('/api/recharge/create', express.json(), async (req, res) => {
  try {
    const { userId, amount, channel = 'UPI' } = req.body;
    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'userId aur valid amount zaroori hai' });
    }

    const receipt = 'RC_' + Date.now() + '_' + Math.floor(1000 + Math.random() * 9000);
    const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
    const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Math.round(amt * 100),
        currency: 'INR',
        receipt,
        notes: { userId: String(userId), channel }
      })
    });
    const rzpJson = await rzpRes.json();
    if (!rzpRes.ok) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: rzpJson.error?.description || 'Order fail' });
    }

    return res.json({
      success: true,
      keyId: RAZORPAY_KEY_ID,
      orderId: rzpJson.id,
      receipt,
      amount: amt,
      amountPaise: rzpJson.amount,
      currency: rzpJson.currency,
      userId: String(userId)
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/recharge/verify', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { userId, amount, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'Invalid signature' });
    }

    await creditRecharge({ userId: String(userId), amount: Number(amount), txId: String(razorpay_payment_id) });
    return res.json({
      success: true,
      uiPosition: 'center',
      message: `₹${Number(amount).toFixed(2)} recharge credit ho gaya!`,
      credited: Number(amount),
      status: 'Success'
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/recharge/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!db) return res.status(200).json({ success: false });
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const payload = JSON.parse(raw.toString('utf8'));
    if (payload.event === 'payment.captured' && payload.payload?.payment?.entity) {
      const p = payload.payload.payment.entity;
      const uid = p.notes?.userId;
      const amt = Number(p.amount || 0) / 100;
      const txId = p.id || ('TX_' + Date.now());
      if (uid && amt > 0) {
        await creditRecharge({ userId: String(uid), amount: amt, txId });
      }
    }
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/withdraw/auto-upi', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const {
      userId,
      amount,
      withdrawPassword,
      bankName = '',
      realName = '',
      bankAccount = '',
      upiId = ''
    } = req.body;

    const amt = Number(amount);
    if (!userId || !amt || amt <= 0) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'userId aur valid amount zaroori hai' });
    }

    const uSnap = await db.collection('users').doc(String(userId)).get();
    if (uSnap.exists && uSnap.data().withdrawPasswordHash) {
      if (!withdrawPassword || hashSecret(withdrawPassword) !== uSnap.data().withdrawPasswordHash) {
        return res.status(401).json({ success: false, uiPosition: 'center', message: 'Galat withdraw password hai' });
      }
    }

    const wdId = 'WD_' + Date.now();
    const payoutId = 'PAY_' + Date.now();

    await db.runTransaction(async (tx) => {
      const uRef = db.collection('users').doc(String(userId));
      const wRef = db.collection('withdrawals').doc(wdId);
      const bRef = db.collection('bills').doc();

      const uDoc = await tx.get(uRef);
      const u = uDoc.exists ? uDoc.data() : {};
      const curW = Number(u.withdrawalBalance || 0);
      if (curW < amt) throw new Error('Withdrawal balance kam hai');

      tx.set(
        uRef,
        {
          withdrawalBalance: curW - amt,
          totalWithdraw: Number(u.totalWithdraw || 0) + amt,
          bankName: bankName ? String(bankName).trim() : (u.bankName || ''),
          realName: realName ? String(realName).trim() : (u.realName || ''),
          bankAccount: bankAccount ? String(bankAccount).trim() : (u.bankAccount || '')
        },
        { merge: true }
      );

      tx.set(wRef, {
        id: wdId,
        userId: String(userId),
        amount: amt,
        bankName: String(bankName || u.bankName || '').trim(),
        realName: String(realName || u.realName || '').trim(),
        bankAccount: String(bankAccount || u.bankAccount || '').trim(),
        upiId: String(upiId || '').trim(),
        status: 'Success',
        payoutId,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      tx.set(bRef, {
        userId: String(userId),
        type: 'Withdrawal',
        amount: `-₹${amt.toFixed(2)}`,
        status: 'Success',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({
      success: true,
      uiPosition: 'center',
      message: `₹${amt.toFixed(2)} withdrawal successful!`,
      withdrawalId: wdId,
      payoutId,
      status: 'Success'
    });
  } catch (err) {
    return res.status(400).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

// ============================================================================
// 9. BLOG PROOF, BANNERS, UID BONUS, SUPPORT & ADMIN OVERVIEW[span_12](start_span)[span_12](end_span)[span_13](start_span)[span_13](end_span)[span_14](start_span)[span_14](end_span)
// ============================================================================
app.post('/api/blog/submit', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { userId, text = '', images = [] } = req.body;
    const pics = Array.isArray(images) ? images.slice(0, 2) : [];
    if (!userId || (!text && pics.length === 0)) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'Text ya 1-2 images zaroori hain' });
    }

    const postId = 'BLOG_' + Date.now();
    const post = {
      id: postId,
      userId: String(userId),
      text: String(text),
      images: pics,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('blog_proofs').doc(postId).set(post);
    return res.json({ success: true, uiPosition: 'center', message: 'Proof publish ho gaya', post });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/blog/list', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('blog_proofs').get();
    return res.json({
      success: true,
      posts: snap.docs.map((d) => ({ id: d.id, ...d.data(), canAdminDownload: true }))
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/config', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const [cfgSnap, usersSnap] = await Promise.all([
      db.collection('app_config').doc('main').get(),
      db.collection('users').get()
    ]);
    const activeUsersCount = usersSnap.docs.filter((d) => Boolean(d.data().isActive)).length;
    return res.json({
      success: true,
      activeUsersCount,
      totalUsersCount: usersSnap.size,
      config: cfgSnap.exists
        ? cfgSnap.data()
        : { popupBanner: { image: '', text: '', link: '' }, homeBanner: { image: '', text: '', link: '' } }
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/admin/config', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { popupBanner, homeBanner, ...rest } = req.body;
    await db.collection('app_config').doc('main').set(
      {
        ...rest,
        ...(popupBanner ? { popupBanner } : {}),
        ...(homeBanner ? { homeBanner } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    return res.json({ success: true, uiPosition: 'center', message: 'Config/Banner update ho gaya' });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/admin/bonus/uid', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { uid, amount, balanceTarget = 'withdrawalBalance' } = req.body;
    const target = String(uid || '').trim();
    const amt = Number(amount || 0);
    if (!target || amt <= 0) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'Valid UID aur amount zaroori hai' });
    }

    const field = balanceTarget === 'chargedBalance' ? 'chargedBalance' : 'withdrawalBalance';
    await db.runTransaction(async (tx) => {
      const uRef = db.collection('users').doc(target);
      const bRef = db.collection('bills').doc();
      const uSnap = await tx.get(uRef);
      const cur = uSnap.exists ? Number(uSnap.data()[field] || 0) : 0;
      tx.set(uRef, { userId: target, [field]: cur + amt }, { merge: true });
      tx.set(bRef, {
        userId: target,
        type: 'UID Bonus',
        amount: `+₹${amt.toFixed(2)}`,
        status: 'Success',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({ success: true, uiPosition: 'center', message: `UID ${target} ko ₹${amt.toFixed(2)} bonus mil gaya` });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/service/ticket', express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'userId aur message zaroori hai' });
    }
    const ticketId = 'TKT_' + Date.now();
    const ticket = {
      id: ticketId,
      userId: String(userId),
      message: String(message),
      adminReply: '',
      status: 'Open',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('tickets').doc(ticketId).set(ticket);
    return res.json({ success: true, uiPosition: 'center', message: 'Ticket bhej diya gaya hai', ticket });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.post('/api/admin/service/reply', requireAdmin, express.json(), async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const { ticketId, reply } = req.body;
    if (!ticketId || !reply) {
      return res.status(400).json({ success: false, uiPosition: 'center', message: 'ticketId aur reply zaroori hai' });
    }
    await db.collection('tickets').doc(String(ticketId)).set(
      { adminReply: String(reply), status: 'Replied', repliedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return res.json({ success: true, uiPosition: 'center', message: 'Reply send ho gaya' });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/service/tickets/:userId', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const snap = await db.collection('tickets').where('userId', '==', String(req.params.userId)).get();
    return res.json({ success: true, tickets: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const [usersSnap, wdSnap, ordSnap, rcSnap] = await Promise.all([
      db.collection('users').get(),
      db.collection('withdrawals').get(),
      db.collection('orders').get(),
      db.collection('recharges').get()
    ]);

    let totalChargedBalance = 0;
    let totalWithdrawalBalance = 0;
    let totalInvestmentAmount = 0;
    let totalRechargeAmount = 0;
    let totalWithdrawAmount = 0;

    const users = usersSnap.docs.map((d) => {
      const u = d.data();
      totalChargedBalance += Number(u.chargedBalance || 0);
      totalWithdrawalBalance += Number(u.withdrawalBalance || 0);
      totalInvestmentAmount += Number(u.totalInvestment || 0);
      const item = { id: d.id, ...u };
      delete item.passwordHash;
      delete item.withdrawPasswordHash;
      return item;
    });

    rcSnap.forEach((d) => {
      totalRechargeAmount += Number(d.data().amount || 0);
    });

    wdSnap.forEach((d) => {
      totalWithdrawAmount += Number(d.data().amount || 0);
    });

    return res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        totalChargedBalance,
        totalWithdrawalBalance,
        totalRechargeAmount,
        totalWithdrawAmount,
        totalInvestmentAmount
      },
      users,
      investments: ordSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      withdrawals: wdSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    });
  } catch (err) {
    return res.status(500).json({ success: false, uiPosition: 'center', message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ProInvast Complete API running on port ${PORT}`);
});
