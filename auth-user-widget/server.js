require("dotenv").config();
const express          = require("express");
const session          = require("express-session");
const jwt              = require("jsonwebtoken");
const { v4: uuidv4 }   = require("uuid");
const { OAuth2Client } = require("google-auth-library");
const path             = require("path");
const axios            = require("axios");
const { User }         = require("./db");

const app = express();

// ─── Config ────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI  || "http://localhost:4000/auth/google/callback";
const SESSION_SECRET       = process.env.SESSION_SECRET;
const JWT_SECRET           = process.env.JWT_SECRET;

// Sunshine / Zendesk Messaging Credentials
const SUNSHINE_APP_ID      = "60686d3eba725200d23f2647"; 
const SUNSHINE_KEY_ID      = "int_69d78be22de56b376d11d116"; 
const SUNSHINE_KEY_SECRET  = "tl2rQTJztAwvobOg0A1m-dRA9Lm_lLqymEoKixYADls_2YQdE72AOHCJMO-LYy3kC6nEk8G32dKgqD_rvC4Plg";
const ZD_SHARED_KEY        = process.env.ZD_SHARED_KEY || SUNSHINE_KEY_SECRET;

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

// ─── Guards ────────────────────────────────────────────────────────────────────
function requireSessionPage(req, res, next) {
  if (!req.session.user) return res.redirect("/");
  next();
}

function requireSessionAPI(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function requireJWT(req, res, next) {
  const auth  = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    console.log("go to next")
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── Page Routes ───────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (req.session.user) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/auth/google", (req, res) => {
  const url = googleClient.generateAuthUrl({
    access_type: "offline",
    scope: ["profile", "email"],
    prompt: "consent",
  });
  res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { tokens } = await googleClient.getToken(req.query.code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const { sub: googleId, name, email, picture } = ticket.getPayload();

    let user;
    try {
      user = await User.findOneAndUpdate(
        { googleId },
        { googleId, name, email, avatar: picture },
        { upsert: true, new: true }
      );
    } catch {
      user = { _id: uuidv4(), googleId, name, email, avatar: picture };
    }

    req.session.user = { id: String(user._id), googleId, name, email, avatar: picture };
    req.session.jwt  = jwt.sign(
      { id: String(user._id), name, email },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    console.log(`✅ Session created for: ${email}`);
    res.redirect("/dashboard");
  } catch (err) {
    console.error("❌ Google callback error:", err.message);
    res.status(400).send(`<h3>Auth failed</h3><a href="/">Back</a>`);
  }
});

app.get("/dashboard", requireSessionPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ─── API Routes ────────────────────────────────────────────────────────────────
app.get("/api/user", requireSessionAPI, (req, res) => {
  res.json({
    token:  req.session.jwt,
    name:   req.session.user.name,
    email:  req.session.user.email,
    avatar: req.session.user.avatar,
  });
});

// Route for the Zendesk Widget Login
app.get("/api/zendesk-token", requireJWT, (req, res) => {
  const now = Math.floor(Date.now() / 1000);

  const zdToken = jwt.sign(
    {
      scope:       "user",
      name:        req.user.name,
      email:       req.user.email,
      external_id: req.user.id,
      iat:         now - 30,
      jti:         uuidv4(),
      exp:         now + (5 * 60),
    },
    process.env.ZD_SHARED_SECRET,   // ✅ sign with the shared secret
    {
      algorithm: "HS256",
      header: {
        alg: "HS256",
        kid: process.env.ZD_KID,    // ✅ Key ID goes in the header
        typ: "JWT"
      }
    }
  );

  res.json({ token: zdToken });
});

// Route to fetch Conversation List via Sunshine API
app.get("/api/conversations", requireJWT, async (req, res) => {
  // Basic Auth: base64(KEY_ID:KEY_SECRET)
  const authString = Buffer.from(`${SUNSHINE_KEY_ID}:${SUNSHINE_KEY_SECRET}`).toString("base64");

  try {
    const baseUrl = `https://api.smooch.io/v2/apps/${SUNSHINE_APP_ID}`;

    console.log("📍 Fetching conversations for user ID:", req.user.id);

    // 1. Try to find existing Sunshine user by externalId
    let userId;
    try {
      const userRes = await axios.get(`${baseUrl}/users/externalId:${req.user.id}`, {
        headers: { Authorization: `Basic ${authString}` }
      });
      userId = userRes.data.user.id;
      console.log("✅ Found existing Sunshine user:", userId);
    } catch (userErr) {
      // User doesn't exist - create one
      if (userErr.response?.status === 404) {
        console.log("⚠️ No Sunshine user found for externalId:", req.user.id);
        console.log("📝 Creating new Sunshine user...");
        
        try {
          const createRes = await axios.post(
            `${baseUrl}/users`,
            {
              externalId: req.user.id,
              firstName: req.user.name?.split(" ")[0] || "User",
              lastName: req.user.name?.split(" ")[1] || "",
              email: req.user.email,
              avatarUrl: req.user.avatar || undefined
            },
            { headers: { Authorization: `Basic ${authString}` } }
          );
          userId = createRes.data.user.id;
          console.log("✅ New Sunshine user created:", userId);
        } catch (createErr) {
          console.error("❌ Failed to create Sunshine user:", createErr.response?.data || createErr.message);
          return res.status(500).json({ 
            error: "Failed to create chat user", 
            details: createErr.message 
          });
        }
      } else {
        throw userErr;
      }
    }

    // 2. Fetch the conversations list for this user
    const convRes = await axios.get(`${baseUrl}/conversations?filter[userId]=${userId}`, {
      headers: { Authorization: `Basic ${authString}` }
    });

    console.log("✅ Retrieved conversations:", convRes.data.conversations?.length || 0);
    res.json(convRes.data.conversations || []);
  } catch (error) {
    console.error("❌ Sunshine API Error:", error.response?.data || error.message);
    res.status(error.response?.status || 500).json(error.response?.data || { error: "API Failure" });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Server → http://localhost:${PORT}`);
});