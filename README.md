# ❄️ MELCloud Home → Google Home Bridge

Connect your **Mitsubishi Electric air conditioners** using the new **MELCloud Home** app to **Google Home** through a Cloudflare Worker.

This project acts as a bridge between Mitsubishi's undocumented **MELCloud Home mobile API** and **Google Smart Home**, allowing you to control your air conditioners from Google Home.

The bridge can persist your authentication tokens using **Cloudflare D1**, so you don't have to manually log in again every time the Worker restarts.

---

## ✨ Features

* 🌡️ Control Mitsubishi Electric air conditioners from Google Home
* 🔌 Turn air conditioners on and off
* 🌡️ Set the target temperature
* 🏠 Assign devices to Google Home rooms
* 🔐 MELCloud Home authentication
* 💾 Persistent OAuth/session tokens using Cloudflare D1
* 🔄 Automatic session reuse
* ☁️ Runs entirely on Cloudflare Workers
* 🔒 HTTP Basic Authentication for the administration interface
* 🚫 No MELCloud credentials hardcoded in the source code

---

# 📋 Requirements

Before getting started, make sure you have:

* A **MELCloud Home account**
* Your MELCloud Home email address and password
* A free **Cloudflare account**
* A **Google account**
* The **Google Home** app installed on your smartphone

You will also need access to the JavaScript source code of this project.

---

# ☁️ Step 1 — Create the Cloudflare D1 Database

The D1 database is used to securely store your authentication tokens.

This allows the bridge to keep your session between Worker restarts without requiring you to enter your MELCloud Home credentials every time.

## 1. Open Cloudflare

Log in to your Cloudflare dashboard.

From the left-hand menu, go to:

**Workers & Pages → D1 SQL Database**

## 2. Create the database

Click:

**Create database**

Choose a name, for example:

```text
melhome-db
```

Then click **Create**.

## 3. Create the token table

Open your newly created database and select the **Console** tab.

Run the following SQL command:

```sql
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Your D1 database is now ready.

---

# 🚀 Step 2 — Create the Cloudflare Worker

The Cloudflare Worker is the core of the bridge.

It communicates with MELCloud Home, handles Google Home requests and manages authentication.

## 1. Create the Worker

In Cloudflare, go to:

**Workers & Pages → Overview**

Then select:

**Create application → Create Worker**

Give the Worker a name, for example:

```text
melhome-bridge
```

Click **Deploy**.

## 2. Add the project code

Once the Worker has been created:

1. Click **Edit code**
2. Delete the default code
3. Paste the complete JavaScript code from this project
4. Click **Deploy**

Your Worker is now running.

---

# 🔗 Step 3 — Bind the D1 Database to the Worker

The Worker needs access to the D1 database created in Step 1.

Open your Worker:

**melhome-bridge → Settings → Bindings**

> Depending on the Cloudflare dashboard version, this section may appear under **Variables & Secrets**.

## Add the D1 binding

Click:

**Add → D1 Database**

Configure it as follows:

| Setting       | Value        |
| ------------- | ------------ |
| Variable name | `DB`         |
| D1 Database   | `melhome-db` |

⚠️ **The variable name must be exactly `DB` and must be uppercase.**

Click **Deploy**.

---

# 🔑 Step 4 — Connect MELCloud Home

Your Worker will have a URL similar to:

```text
https://melhome-bridge.your-username.workers.dev
```

Open this URL in your browser.

You will arrive at the bridge homepage.

Click:

**🔐 Configure MELCloud**

Enter your:

* MELCloud Home email address
* MELCloud Home password

Submit the form.

## Verify the connection

If the login succeeds, click:

**🌡️ View my ACs**

You should see your Mitsubishi air conditioners.

You can use this page to verify that the bridge is communicating correctly with MELCloud Home.

💡 **Keep your Worker URL. You will need it when configuring Google Home.**

---

# 🏠 Step 5 — Configure the Google Home Action

Google Home needs to know where your bridge is located.

## 1. Create a Google project

Open the **Google Actions Console** and sign in with the same Google account you use with Google Home.

Create a new project.

For example:

```text
My MELCloud ACs
```

Select your language and country, then click **Create project**.

---

## 2. Enable Smart Home

Inside your project, select:

**Smart Home → Start Building**

From the left-hand menu, open:

**Actions**

In the **Fulfillment URL** field, enter your Worker URL followed by:

```text
/google/fulfillment
```

For example:

```text
https://melhome-bridge.your-username.workers.dev/google/fulfillment
```

Click **Save**.

---

# 🔐 Step 6 — Configure Account Linking

In Google Actions Console, go to:

**Develop → Account linking**

Use the following settings:

| Setting           | Value                                  |
| ----------------- | -------------------------------------- |
| Client ID         | `google`                               |
| Client Secret     | `secret`                               |
| Authorization URL | `https://YOUR_WORKER_URL/google/auth`  |
| Token URL         | `https://YOUR_WORKER_URL/google/token` |

Replace `YOUR_WORKER_URL` with your actual Worker URL.

For example:

```text
https://melhome-bridge.your-username.workers.dev/google/auth
```

and:

```text
https://melhome-bridge.your-username.workers.dev/google/token
```

Leave the remaining settings at their default values.

Click **Save**.

---

# 🧪 Step 7 — Enable Test Mode

At the top of the Google Actions Console, open the:

**Test**

tab.

Enable your project for your Google account.

Your Smart Home integration is now ready to be linked with Google Home.

---

# 📱 Step 8 — Link MELCloud Home with Google Home

Open the **Google Home** app on your smartphone.

### Follow these steps:

1. Tap **+**
2. Select **Set up device**
3. Select **Works with Google**
4. Search for your project

If your project is named:

```text
My MELCloud ACs
```

search for:

```text
[test] My MELCloud ACs
```

Select your integration.

A web page will open asking for the security PIN.

Enter:

```text
1234
```

Submit the PIN.

Google Home should now synchronize your MELCloud Home air conditioners.

You can then assign each device to the appropriate room.

---

# 🗣️ Control Your Air Conditioners

Once the integration is configured, you can control your air conditioners using Google Assistant.

For example:

> **"Hey Google, turn on the living room."**

or:

> **"Hey Google, set the bedroom temperature to 24 degrees."**

---

# 🔒 Security & Data Protection

The administration interface is protected using **HTTP Basic Authentication**.

This prevents someone who discovers your Worker URL from freely accessing the administration pages or controlling your air conditioners.

Administration credentials are stored in **Cloudflare D1** rather than being hardcoded into the source code.

### ⚠️ Important

Never publish:

* Your MELCloud Home password
* Your administrator password
* OAuth/session tokens
* Other private credentials or secrets

The source code can be safely shared publicly as long as no personal credentials or tokens are included in it.

---

# 🔐 Configure Administrator Credentials

Open your Cloudflare D1 database:

**Workers & Pages → D1 SQL Database → melhome-db → Console**

First create the configuration table:

```sql
CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Then configure your administrator credentials:

```sql
INSERT OR REPLACE INTO app_config (key, value)
VALUES ('admin_user', 'admin');

INSERT OR REPLACE INTO app_config (key, value)
VALUES ('admin_pass', 'your_secure_password_here');
```

Replace:

```text
your_secure_password_here
```

with a strong password of your choice.

## Protected pages

The following administration pages are protected:

```text
/
/setup
/devices
```

Your browser will ask for:

**Username**

```text
admin
```

**Password**

```text
your_secure_password
```

The Google integration routes:

```text
/google/...
```

remain accessible to Google's servers so that the Smart Home integration can function correctly.

---

# 🛠️ Troubleshooting

## ❌ Google Home says the device is offline or unavailable

The most likely cause is that your MELCloud authentication token has been revoked.

This can happen, for example, if you change your MELCloud Home password in the official application.

### Solution

Open your Worker URL:

```text
https://melhome-bridge.your-username.workers.dev
```

Then select:

**🔐 Configure MELCloud**

Log in again using your MELCloud Home credentials.

A new authentication token will be obtained and stored in Cloudflare D1.

Google Home should then be able to communicate with your air conditioners again.

---

## ❓ How can I change the Google Home PIN?

The default PIN is:

```text
1234
```

It is defined in the Worker code using:

```javascript
GOOGLE_HOME_PIN = "1234";
```

To change it:

1. Open your Worker in Cloudflare
2. Open the source code
3. Search for `GOOGLE_HOME_PIN`
4. Replace `1234` with your new PIN
5. Click **Deploy**

⚠️ You will need to use the new PIN the next time you link the integration with Google Home.

---

# 🧩 How It Works

The bridge works as follows:

```text
┌─────────────────────┐
│     Google Home     │
└──────────┬──────────┘
           │
           │ Smart Home API
           ▼
┌─────────────────────┐
│   Cloudflare Worker │
│   melhome-bridge    │
└───────┬───────┬─────┘
        │       │
        │       │
        ▼       ▼
┌────────────┐ ┌──────────────┐
│ Cloudflare │ │ MELCloud Home│
│     D1     │ │     API      │
└────────────┘ └──────┬───────┘
                       │
                       ▼
               ┌───────────────┐
               │ Air Condition.│
               │   Mitsubishi  │
               └───────────────┘
```

### Component Overview

**Google Home**
Sends commands and receives the state of your devices.

**Cloudflare Worker**
Acts as the bridge between Google Home and MELCloud Home.

**Cloudflare D1**
Stores the information required to maintain the authentication session.

**MELCloud Home**
Provides access to your Mitsubishi Electric air conditioners.

---

# ⚠️ Disclaimer

This project uses communication interfaces from MELCloud Home that are not publicly documented.

Future changes to the MELCloud Home application or Mitsubishi Electric's servers may therefore affect compatibility.

This project is **not officially affiliated with or endorsed by Mitsubishi Electric, MELCloud or Google**.

---

# 📄 License

Add your preferred license here.

For example:

```text
MIT License
```

if you intend to distribute this project under the MIT License.

---

# ⭐ Credits

Developed to integrate **Mitsubishi Electric / MELCloud Home** air conditioners with **Google Home** using **Cloudflare Workers** and **Cloudflare D1**.
