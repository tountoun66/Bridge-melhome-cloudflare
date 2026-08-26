❄️ MELCloud Home to Google Home Bridge (via Cloudflare)
This project allows you to connect your Mitsubishi air conditioners (using the new MELCloud Home app) to Google Home. It relies on a free Cloudflare Worker to act as a seamless bridge between Mitsubishi's undocumented mobile API and Google's Smart Home servers, keeping your connection alive autonomously.

📋 Prerequisites
Before you begin, make sure you have:

Your MELCloud Home app credentials (email and password).

A free Cloudflare account (cloudflare.com).

A Google account (the same one used in the Google Home app on your phone).

🛠️ Step 1: Create the Database (Cloudflare D1)
The script needs a small database to securely save your session tokens so you don't have to re-enter your password every day.

Log in to your Cloudflare dashboard.

In the left sidebar, navigate to Workers & Pages > D1 SQL Database.

Click the blue Create database button.

Give it a name (e.g., melhome-db) and click Create.

Once created, click on its name to open it.

Go to the Console tab.

Copy and paste the following SQL command into the text area, then click Execute:

SQL
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
Your database is now ready!

🚀 Step 2: Create the Cloudflare Worker
The Worker is the brain of the system: it hosts the code and handles the API requests.

In the left sidebar of Cloudflare, go to Workers & Pages > Overview.

Click Create application, then Create Worker.

Give it a name (e.g., melhome-bridge) and click Deploy.

On the confirmation page, click Edit code.

In the editor that opens, delete all existing code and paste the entire JavaScript code of this project.

Click the blue Deploy button in the top right corner.

🔗 Step 3: Bind the Database to the Worker
To allow the code to read and write to the database created in Step 1, you need to link them.

Go back to the main page of your Worker (melhome-bridge).

Go to the Settings tab > Bindings (or Variables & Secrets depending on the UI layout).

Under the "Bindings" section, click Add and choose D1 Database.

Fill out the form as follows:

Variable name: DB (Must be uppercase, this is mandatory)

D1 Database: Select melhome-db (created in step 1).

Click Deploy.

🔑 Step 4: First Connection to MELCloud
At the top of your Worker's page, you will see a URL like [https://melhome-bridge.your-username.workers.dev](https://melhome-bridge.your-username.workers.dev). Click on it.

You will land on the homepage of your bridge. Click on 🔐 Configure MELCloud.

Enter your MELCloud Home credentials and submit.

If a success message appears, click on 🌡️ View my ACs.

You should see your air conditioners listed with the ability to turn them on or off. Keep your Worker's URL handy, we will need it for the next step.

🏠 Step 5: Configure the Google Home Action
Now, you need to tell Google how to talk to your Worker.

Go to the Google Actions Console and log in with your Google account.

Click New Project, give it a name (e.g., "My MELCloud ACs"), select your language/country, and click Create project.

On the next screen, select Smart Home and click Start Building.

In the left menu, click Actions.

Fill the Fulfillment URL field with your Worker's URL followed by /google/fulfillment:

Example: [https://melhome-bridge.your-username.workers.dev/google/fulfillment](https://melhome-bridge.your-username.workers.dev/google/fulfillment)

Click Save.

In the left menu, go to Develop > Account linking. Fill in the fields exactly like this:

Client ID: google

Client Secret: secret

Authorization URL: https://[YOUR_WORKER_URL]/google/auth

Token URL: https://[YOUR_WORKER_URL]/google/token

Leave the rest as default and click Save in the top right corner.

Go to the Test tab (at the top of the screen) to enable your project on your Google account.

📱 Step 6: Link in the Google Home App
This is the final step!

Open the Google Home app on your smartphone.

Tap the + button in the top left corner.

Choose Set up device > Works with Google.

In the search bar, type [test] My MELCloud ACs (or whatever you named your project).

Tap on it. A web page will open asking for a security PIN.

Enter the default PIN: 1234 and submit.

Success! Google Home will sync your air conditioners. You just need to assign them to your rooms.

You can now control your devices using your voice: "Ok Google, turn on the living room", "Ok Google, set the bedroom temperature to 24 degrees".

🛠️ Troubleshooting & FAQ
Google Home says the device is offline or unavailable.
It is highly likely that your MELCloud token has been revoked by Mitsubishi (for example, if you changed your password in the official app).
Solution: Go back to your Cloudflare Worker URL, click "Configure MELCloud," and log in again to fetch a new token. Google Home will immediately start working again.

Where can I change the "1234" PIN code?
If you want to secure the linking process, you can change the GOOGLE_HOME_PIN = "1234"; constant at the very top of your Worker's code in Cloudflare, then click Deploy.
