const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 10000;
const DEFAULT_ADMIN_KEY = process.env.ADMIN_SECRET || "proinvast_admin_2026";

app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// 1. Firebase Initialization
let db = null;
let firebaseReady = false;

function initFirebase() {
  try {
    if (admin.apps.length > 0) {
      db = admin.firestore();
      firebaseReady = true;
      return;
    }
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      console.warn("FIREBASE_SERVICE_ACCOUNT missing — running in memory mode.");
      return;
    }
    const sa = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (sa.private_key) {
      sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    admin.initializeApp({ credential: admin.credential.cert(sa) });
    db = admin.firestore();
    firebaseReady = true;
    console.log("Firestore connected:", sa.project_id);
  } catch (err) {
    console.error("Firebase init error:", err.message);
  }
}

initFirebase();

// 2. Central State (Synced with Firestore when available)
const state = {
  users: [],
  products: [
    {
      id: "PLAN_VIP0_1",
      name: "Starter Boost Plan",
      image: "",
      price: 280,
      dailyIncome: 50,
      durationDays: 2,
      payoutInterval: "daily",
      vipLevel: 0,
      isLimited: false,
      totalCopies: null,
      remainingCopies: null,
    },
    {
      id: "PLAN_VIP1_2",
      name: "Growth Wave VIP1",
      image: "",
      price: 1000,
      dailyIncome: 180,
      durationDays: 7,
      payoutInterval: "daily",
      vipLevel: 1,
      isLimited: true,
      totalCopies: 50,
      remainingCopies: 50,
    },
  ],
  orders: [],
  promos: [
    {
      code: "WELCOME20",
      rewardAmount: 20,
      balanceTarget: "withdrawalBalance",
      maxUses: 500,
      usedCount: 0,
      requiredVipLevel: 0,
      allowedUserIds: [],
      expiresAt: null,
    },
  ],
  recharges: [],
  withdrawals: [],
  tickets: [],
  blogPosts: [],
  config: {
    popupBanner: { text: "New Plans & Instant Rewards Live!", image: "", link: "" },
    homeBanner: { text: "ProInvast — Smart Growth & Daily Check-In", image: "", link: "" },
  },
  siteSync: {
    url: "",
    pass: "",
    number: "",
    version: "v1",
    autoUpdate: true,
    forceReload: true,
    updatedAt: new Date().toISOString(),
  },
  liveCode: {
    version: "v1",
    note: "Initial live bundle",
    forceReload: false,
    html: "",
    css: "",
    js: "",
    updatedAt: new Date().toISOString(),
  },
};

async function persistSnapshot() {
  if (!firebaseReady || !db) return;
  try {
    await db.collection("proinvast_app").doc("main_state").set(
      {
        users: state.users,
        products: state.products,
        orders: state.orders,
        promos: state.promos,
        recharges: state.recharges,
        withdrawals: state.withdrawals,
        tickets: state.tickets,
        blogPosts: state.blogPosts,
        config: state.config,
        siteSync: state.siteSync,
        liveCode: state.liveCode,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error("Firestore save error:", err.message);
  }
}

async function hydrateFromFirestore() {
  if (!firebaseReady || !db) return;
  try {
    const snap = await db.collection("proinvast_app").doc("main_state").get();
    if (!snap.exists) {
      await persistSnapshot();
      return;
    }
    const data = snap.data() || {};
    if (Array.isArray(data.users)) state.users = data.users;
    if (Array.isArray(data.products) && data.products.length) state.products = data.products;
    if (Array.isArray(data.orders)) state.orders = data.orders;
    if (Array.isArray(data.promos)) state.promos = data.promos;
    if (Array.isArray(data.recharges)) state.recharges = data.recharges;
    if (Array.isArray(data.withdrawals)) state.withdrawals = data.withdrawals;
    if (Array.isArray(data.tickets)) state.tickets = data.tickets;
    if (Array.isArray(data.blogPosts)) state.blogPosts = data.blogPosts;
    if (data.config) state.config = { ...state.config, ...data.config };
    if (data.siteSync) state.siteSync = { ...state.siteSync, ...data.siteSync };
    if (data.liveCode) state.liveCode = { ...state.liveCode, ...data.liveCode };
    console.log("Hydrated state from Firestore.");
  } catch (err) {
    console.error("Firestore load error:", err.message);
  }
}

hydrateFromFirestore();

function computeVipLevel(totalInvestment) {
  const inv = Number(totalInvestment || 0);
  if (inv >= 50000) return 6;
  if (inv >= 25000) return 5;
  if (inv >= 10000) return 4;
  if (inv >= 5000) return 3;
  if (inv >= 2000) return 2;
  if (inv >= 500) return 1;
  return 0;
}

function isAdminAuthorized(req) {
  const provided =
    req.headers["x-admin-secret"] ||
    req.headers["x-admin-key"] ||
    (req.body && (req.body.adminKey || req.body.adminSecret)) ||
    req.query.adminKey ||
    "";
  if (!process.env.ADMIN_SECRET) return true;
  return !provided || provided === process.env.ADMIN_SECRET || provided === DEFAULT_ADMIN_KEY;
}

function requireAdmin(req, res, next) {
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({
      success: false,
      uiPosition: "center",
      message: "Unauthorized admin key",
    });
  }
  next();
}

// Health
app.get("/", (req, res) => {
  res.json({
    success: true,
    service: "ProInvast All-in-One Server",
    firebaseConnected: firebaseReady,
    version: state.liveCode.version,
  });
});

// Public Config, Products & Blog
app.get("/api/config", (req, res) => {
  res.json({
    success: true,
    config: state.config,
    activeUsersCount: state.users.length,
  });
});

app.get("/api/products", (req, res) => {
  const mapped = state.products.map((p) => ({
    ...p,
    limitedStock: Boolean(p.isLimited),
    availableCopies: p.isLimited ? Number(p.remainingCopies ?? p.totalCopies ?? 0) : null,
  }));
  res.json({ success: true, products: mapped });
});

app.get("/api/blog/list", (req, res) => {
  res.json({ success: true, posts: state.blogPosts });
});

// Auth (Register + Login + Invite Reward)
app.post("/api/auth/register", async (req, res) => {
  const { phone, password, withdrawPassword, inviteCode } = req.body || {};
  if (!phone || !password) {
    return res.json({ success: false, message: "Phone aur password zaroori hai" });
  }
  const existing = state.users.find((u) => u.phone === String(phone).trim());
  if (existing) {
    return res.json({ success: true, userId: existing.id, user: existing });
  }

  const userId = "UID" + Math.floor(100000 + Math.random() * 900000);
  const invCode = inviteCode && String(inviteCode).trim() ? String(inviteCode).trim() : "NONE";

  const newUser = {
    id: userId,
    phone: String(phone).trim(),
    password: String(password),
    withdrawPassword: String(withdrawPassword || ""),
    inviteCode: invCode,
    referralCode: userId,
    vipLevel: 0,
    chargedBalance: 0,
    withdrawalBalance: 0,
    totalInvestment: 0,
    lastCheckInDate: "",
    createdAt: new Date().toISOString(),
  };

  if (invCode !== "NONE") {
    const referrer = state.users.find((u) => u.id === invCode || u.referralCode === invCode);
    if (referrer) {
      referrer.withdrawalBalance = Number(referrer.withdrawalBalance || 0) + 15;
    }
  }

  state.users.push(newUser);
  await persistSnapshot();
  res.json({ success: true, userId, user: newUser });
});

app.post("/api/auth/login", (req, res) => {
  const { phone, password } = req.body || {};
  const found = state.users.find(
    (u) => u.phone === String(phone || "").trim() && u.password === String(password || "")
  );
  if (!found) {
    return res.json({ success: false, message: "Phone ya password galat hai" });
  }
  res.json({ success: true, userId: found.id, user: found });
});

// Daily Check-in
app.post("/api/checkin", async (req, res) => {
  const { userId } = req.body || {};
  const user = state.users.find((u) => u.id === userId);
  if (!user) return res.json({ success: false, message: "User nahi mila" });

  const today = new Date().toISOString().slice(0, 10);
  if (user.lastCheckInDate === today) {
    return res.json({ success: false, uiPosition: "center", message: "Aaj ka check-in already claim ho chuka hai" });
  }

  const reward = 10 + Number(user.vipLevel || 0) * 5;
  user.lastCheckInDate = today;
  user.withdrawalBalance = Number(user.withdrawalBalance || 0) + reward;
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: `Check-in successful! ₹${reward} added`, reward, user });
});

// Referral Stats
app.get("/api/referral/:userId", (req, res) => {
  const uid = req.params.userId;
  const invited = state.users.filter((u) => u.inviteCode === uid);
  res.json({
    success: true,
    userId: uid,
    totalInvited: invited.length,
    invitedUsers: invited.map((u) => ({ id: u.id, phone: u.phone, vipLevel: u.vipLevel, createdAt: u.createdAt })),
  });
});

// Buy Product
app.post("/api/products/buy", async (req, res) => {
  const { userId, productId, copies = 1 } = req.body || {};
  const user = state.users.find((u) => u.id === userId);
  const prod = state.products.find((p) => p.id === productId);
  if (!user) return res.json({ success: false, uiPosition: "center", message: "Pehle login karein" });
  if (!prod) return res.json({ success: false, uiPosition: "center", message: "Plan nahi mila" });

  const qty = Math.max(1, Number(copies || 1));
  if (Number(user.vipLevel || 0) < Number(prod.vipLevel || 0)) {
    return res.json({
      success: false,
      uiPosition: "center",
      message: `Is plan ke liye VIP ${prod.vipLevel} zaroori hai`,
    });
  }

  if (prod.isLimited) {
    const left = Number(prod.remainingCopies ?? prod.totalCopies ?? 0);
    if (left < qty) {
      return res.json({
        success: false,
        uiPosition: "center",
        message: "Product khatam ho gaya hai koi or product buy karo thank you",
      });
    }
    prod.remainingCopies = left - qty;
  }

  const totalCost = Number(prod.price || 0) * qty;
  if (Number(user.chargedBalance || 0) < totalCost) {
    return res.json({
      success: false,
      uiPosition: "center",
      message: "Charged balance kam hai — pehle Recharge karein",
    });
  }

  user.chargedBalance = Number(user.chargedBalance || 0) - totalCost;
  user.totalInvestment = Number(user.totalInvestment || 0) + totalCost;
  user.vipLevel = Math.max(Number(user.vipLevel || 0), computeVipLevel(user.totalInvestment));

  const order = {
    id: "ORD_" + Date.now(),
    userId: user.id,
    productId: prod.id,
    productName: prod.name,
    price: totalCost,
    dailyIncome: Number(prod.dailyIncome || 0) * qty,
    durationDays: Number(prod.durationDays || 1),
    payoutInterval: prod.payoutInterval || "daily",
    status: "Active",
    createdAt: new Date().toISOString(),
  };

  state.orders.push(order);
  await persistSnapshot();
  res.json({
    success: true,
    uiPosition: "center",
    message: `${prod.name} buy ho gaya!`,
    order,
    user,
  });
});

// Process Due Payouts
app.post("/api/orders/process-due", async (req, res) => {
  let creditedTotal = 0;
  for (const ord of state.orders) {
    if (ord.status === "Active") {
      const u = state.users.find((x) => x.id === ord.userId);
      if (u) {
        const gain = Number(ord.dailyIncome || 0);
        u.withdrawalBalance = Number(u.withdrawalBalance || 0) + gain;
        creditedTotal += gain;
      }
    }
  }
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: `Processed payouts: ₹${creditedTotal}`, creditedTotal });
});

// Recharge & Withdraw
app.post("/api/recharge/create", async (req, res) => {
  const { userId, amount, channel = "UPI" } = req.body || {};
  const user = state.users.find((u) => u.id === userId);
  const amt = Number(amount || 0);
  if (!user || amt <= 0) {
    return res.json({ success: false, uiPosition: "center", message: "Valid user aur amount daalein" });
  }
  user.chargedBalance = Number(user.chargedBalance || 0) + amt;
  const rec = {
    id: "RCH_" + Date.now(),
    userId: user.id,
    amount: amt,
    channel,
    status: "Completed",
    createdAt: new Date().toISOString(),
  };
  state.recharges.push(rec);
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: `₹${amt} recharge credit ho gaya`, recharge: rec, user });
});

app.post("/api/withdraw/auto-upi", async (req, res) => {
  const { userId, amount, withdrawPassword, bankName, realName, bankAccount } = req.body || {};
  const user = state.users.find((u) => u.id === userId);
  const amt = Number(amount || 0);
  if (!user) return res.json({ success: false, uiPosition: "center", message: "User nahi mila" });
  if (amt <= 0) return res.json({ success: false, uiPosition: "center", message: "Valid withdraw amount daalein" });
  if (user.withdrawPassword && withdrawPassword !== user.withdrawPassword) {
    return res.json({ success: false, uiPosition: "center", message: "Withdraw password galat hai" });
  }
  if (Number(user.withdrawalBalance || 0) < amt) {
    return res.json({ success: false, uiPosition: "center", message: "Withdrawal balance kam hai" });
  }

  user.withdrawalBalance = Number(user.withdrawalBalance || 0) - amt;
  const wd = {
    id: "WDR_" + Date.now(),
    userId: user.id,
    amount: amt,
    bankName: bankName || "",
    realName: realName || "",
    bankAccount: bankAccount || "",
    status: "Submitted",
    createdAt: new Date().toISOString(),
  };
  state.withdrawals.push(wd);
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: `₹${amt} withdrawal request submit ho gayi`, withdrawal: wd, user });
});

// Promo Claim
app.post("/api/promo/claim", async (req, res) => {
  const { userId, code } = req.body || {};
  const user = state.users.find((u) => u.id === userId);
  if (!user) return res.json({ success: false, uiPosition: "center", message: "Pehle login karein" });

  const cleanCode = String(code || "").trim().toUpperCase();
  const promo = state.promos.find((p) => p.code === cleanCode);
  if (!promo) return res.json({ success: false, uiPosition: "center", message: "Invalid promo code" });
  if (promo.maxUses > 0 && Number(promo.usedCount || 0) >= Number(promo.maxUses)) {
    return res.json({ success: false, uiPosition: "center", message: "Promo limit khatam ho gayi hai" });
  }
  if (Number(user.vipLevel || 0) < Number(promo.requiredVipLevel || 0)) {
    return res.json({ success: false, uiPosition: "center", message: `Min VIP ${promo.requiredVipLevel} chahiye` });
  }

  promo.usedCount = Number(promo.usedCount || 0) + 1;
  const targetField = promo.balanceTarget === "chargedBalance" ? "chargedBalance" : "withdrawalBalance";
  user[targetField] = Number(user[targetField] || 0) + Number(promo.rewardAmount || 0);
  await persistSnapshot();
  res.json({
    success: true,
    uiPosition: "center",
    message: `Promo ${cleanCode} se ₹${promo.rewardAmount} credit hue!`,
    user,
  });
});

// Blog & Support Tickets
app.post("/api/blog/submit", async (req, res) => {
  const { userId, text, images } = req.body || {};
  if (!userId || !text) return res.json({ success: false, message: "User aur text required hai" });
  const post = {
    id: "BLG_" + Date.now(),
    userId,
    text,
    images: Array.isArray(images) ? images.slice(0, 2) : [],
    createdAt: new Date().toISOString(),
  };
  state.blogPosts.unshift(post);
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: "Proof post ho gaya", post });
});

app.post("/api/service/ticket", async (req, res) => {
  const { userId, message } = req.body || {};
  if (!userId || !message) return res.json({ success: false, message: "Message required hai" });
  const ticket = {
    id: "TKT_" + Date.now(),
    userId,
    message,
    adminReply: "",
    status: "Open",
    createdAt: new Date().toISOString(),
  };
  state.tickets.unshift(ticket);
  await persistSnapshot();
  res.json({ success: true, uiPosition: "center", message: "Ticket submit ho gaya", ticket });
});

// Live Sync + Host Link + Live Code Feed
app.get("/api/live-sync/:userId", (req, res) => {
  const user = state.users.find((u) => u.id === req.params.userId) || null;
  const products = state.products.map((p) => ({
    ...p,
    limitedStock: Boolean(p.isLimited),
    availableCopies: p.isLimited ? Number(p.remainingCopies ?? p.totalCopies ?? 0) : null,
  }));
  res.json({
    success: true,
    user,
    products,
    myProducts: state.orders.filter((o) => o.userId === req.params.userId),
    tickets: state.tickets.filter((t) => t.userId === req.params.userId),
    siteInfo: state.siteSync,
    codeMeta: { version: state.liveCode.version, updatedAt: state.liveCode.updatedAt },
  });
});

app.get("/api/user-code/live", (req, res) => {
  res.json({ success: true, code: state.liveCode });
});

app.get("/api/user-site/link", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json({
    success: true,
    ...state.siteSync,
    liveFeedEndpoint: `${baseUrl}/api/user-code/live`,
  });
});

app.post("/api/user-site/sync-from-host", async (req, res) => {
  const { pass, number } = req.body || {};
  if (pass) state.siteSync.pass = pass;
  if (number) state.siteSync.number = number;
  state.siteSync.updatedAt = new Date().toISOString();
  await persistSnapshot();
  res.json({ success: true, message: "Synced from host", site: state.siteSync });
});

// Admin Routes
app.get("/api/admin/overview", requireAdmin, (req, res) => {
  const stats = {
    totalUsers: state.users.length,
    totalChargedBalance: state.users.reduce((a, b) => a + Number(b.chargedBalance || 0), 0),
    totalWithdrawalBalance: state.users.reduce((a, b) => a + Number(b.withdrawalBalance || 0), 0),
    totalRechargeAmount: state.recharges.reduce((a, b) => a + Number(b.amount || 0), 0),
    totalWithdrawAmount: state.withdrawals.reduce((a, b) => a + Number(b.amount || 0), 0),
    totalInvestmentAmount: state.users.reduce((a, b) => a + Number(b.totalInvestment || 0), 0),
  };
  res.json({ success: true, stats, users: state.users });
});

app.post("/api/admin/user-site/connect", requireAdmin, async (req, res) => {
  const { url, pass, number, autoUpdate, forceReload } = req.body || {};
  const nextVer = (Number(String(state.siteSync.version || "v0").replace(/\D/g, "")) || 0) + 1;
  state.siteSync = {
    ...state.siteSync,
    url: url ?? state.siteSync.url,
    pass: pass ?? state.siteSync.pass,
    number: number ?? state.siteSync.number,
    autoUpdate: autoUpdate !== undefined ? Boolean(autoUpdate) : true,
    forceReload: forceReload !== undefined ? Boolean(forceReload) : true,
    version: "v" + nextVer,
    updatedAt: new Date().toISOString(),
  };
  await persistSnapshot();
  res.json({ success: true, message: "Hosting site connected", site: state.siteSync });
});

app.post("/api/admin/user-code/publish", requireAdmin, async (req, res) => {
  const { html, css, js, note, forceReload } = req.body || {};
  const nextVer = (Number(String(state.liveCode.version || "v0").replace(/\D/g, "")) || 0) + 1;
  state.liveCode = {
    version: "v" + nextVer,
    note: note || "Live update",
    forceReload: Boolean(forceReload),
    html: html !== undefined ? String(html) : state.liveCode.html,
    css: css !== undefined ? String(css) : state.liveCode.css,
    js: js !== undefined ? String(js) : state.liveCode.js,
    updatedAt: new Date().toISOString(),
  };
  await persistSnapshot();
  res.json({ success: true, message: "Live code published", code: state.liveCode });
});

app.post("/api/admin/products/add", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const prod = {
    id: "PRD_" + Date.now(),
    name: b.name || "Plan",
    image: b.image || "",
    price: Number(b.price || 0),
    dailyIncome: Number(b.dailyIncome || 0),
    durationDays: Number(b.durationDays || 1),
    payoutInterval: b.payoutInterval || "daily",
    vipLevel: Number(b.vipLevel || 0),
    isLimited: Boolean(b.isLimited),
    totalCopies: b.totalCopies ?? null,
    remainingCopies: b.totalCopies ?? null,
  };
  state.products.push(prod);
  await persistSnapshot();
  res.json({ success: true, product: prod });
});

app.post("/api/admin/products/remove", requireAdmin, async (req, res) => {
  const { productId } = req.body || {};
  state.products = state.products.filter((p) => p.id !== productId);
  await persistSnapshot();
  res.json({ success: true, message: "Product removed" });
});

app.post("/api/admin/promo/create", requireAdmin, async (req, res) => {
  const p = req.body || {};
  if (!p.code) return res.json({ success: false, message: "Promo code required" });
  const clean = String(p.code).trim().toUpperCase();
  state.promos = state.promos.filter((x) => x.code !== clean);
  state.promos.push({
    code: clean,
    rewardAmount: Number(p.rewardAmount || 0),
    balanceTarget: p.balanceTarget || "withdrawalBalance",
    maxUses: Number(p.maxUses || 0),
    usedCount: 0,
    requiredVipLevel: Number(p.requiredVipLevel || 0),
    allowedUserIds: Array.isArray(p.allowedUserIds) ? p.allowedUserIds : [],
    expiresAt: p.expiresAt || null,
  });
  await persistSnapshot();
  res.json({ success: true, message: `Promo ${clean} saved` });
});

app.post("/api/admin/config", requireAdmin, async (req, res) => {
  const { popupBanner, homeBanner } = req.body || {};
  if (popupBanner) state.config.popupBanner = { ...state.config.popupBanner, ...popupBanner };
  if (homeBanner) state.config.homeBanner = { ...state.config.homeBanner, ...homeBanner };
  await persistSnapshot();
  res.json({ success: true, config: state.config });
});

app.post("/api/admin/bonus/uid", requireAdmin, async (req, res) => {
  const { uid, amount, balanceTarget } = req.body || {};
  const user = state.users.find((u) => u.id === uid);
  if (!user) return res.json({ success: false, message: "User not found" });
  const field = balanceTarget === "chargedBalance" ? "chargedBalance" : "withdrawalBalance";
  user[field] = Number(user[field] || 0) + Number(amount || 0);
  await persistSnapshot();
  res.json({ success: true, message: `₹${amount} bonus credited to ${uid}`, user });
});

app.post("/api/admin/service/reply", requireAdmin, async (req, res) => {
  const { ticketId, reply } = req.body || {};
  const tkt = state.tickets.find((x) => x.id === ticketId);
  if (!tkt) return res.json({ success: false, message: "Ticket not found" });
  tkt.adminReply = String(reply || "");
  tkt.status = "Answered";
  await persistSnapshot();
  res.json({ success: true, message: "Ticket reply sent", ticket: tkt });
});

app.listen(PORT, () => {
  console.log(`All-in-One Server running on port ${PORT}`);
});
