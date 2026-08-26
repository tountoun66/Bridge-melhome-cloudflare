❄️ Pont MELCloud Home vers Google Home (Via Cloudflare)
Ce projet permet de relier vos climatiseurs Mitsubishi (utilisant la nouvelle application MELCloud Home) à Google Home. Il utilise un Cloudflare Worker gratuit pour faire le pont entre l'API secrète de Mitsubishi et les serveurs de Google, tout en gardant votre connexion active de manière totalement autonome.

📋 Prérequis
Avant de commencer, assurez-vous d'avoir :

Vos identifiants de l'application MELCloud Home (e-mail et mot de passe).

Un compte Cloudflare gratuit (sur cloudflare.com).

Un compte Google (le même que celui utilisé sur votre application Google Home sur votre téléphone).

🛠️ Étape 1 : Création de la base de données (Cloudflare D1)
Le script a besoin d'une petite base de données pour sauvegarder votre session et ne pas vous redemander votre mot de passe tous les jours.

Connectez-vous à votre tableau de bord Cloudflare.

Dans le menu de gauche, allez dans Workers et Pages > D1 SQL Database.

Cliquez sur le bouton bleu Créer une base de données.

Donnez-lui un nom (par exemple : melhome-db) et cliquez sur Créer.

Une fois la base créée, cliquez sur son nom pour l'ouvrir.

Allez dans l'onglet Console.

Copiez-collez la commande SQL suivante dans la zone de texte, puis cliquez sur Exécuter :

SQL
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
Votre base de données est prête !

🚀 Étape 2 : Création du Cloudflare Worker
Le Worker est le cœur du système : c'est lui qui héberge le code.

Toujours dans le menu de gauche de Cloudflare, allez dans Workers et Pages > Aperçu.

Cliquez sur le bouton bleu Créer une application, puis sur Créer un Worker.

Donnez-lui un nom (par exemple : melhome-bridge) et cliquez sur Déployer.

Sur la page de confirmation, cliquez sur Modifier le code.

Dans l'éditeur qui s'ouvre, supprimez tout le code existant et collez l'intégralité du code JavaScript du projet.

Cliquez sur le bouton bleu Déployer en haut à droite.

🔗 Étape 3 : Lier la base de données au Worker
Pour que le code puisse lire et écrire dans la base de données créée à l'Étape 1, il faut les lier.

Revenez sur la page principale de votre Worker (melhome-bridge).

Allez dans l'onglet Paramètres > Variables et liaisons.

Dans la section "Liaisons", cliquez sur Ajouter puis choisissez Base de données D1.

Remplissez le formulaire ainsi :

Nom de la variable : DB (Respectez bien les majuscules, c'est indispensable)

Base de données D1 : Sélectionnez melhome-db (créée à l'étape 1).

Cliquez sur Déployer.

🔑 Étape 4 : Première connexion à MELCloud
En haut de la page de votre Worker, vous verrez un lien du type [https://melhome-bridge.votre-pseudo.workers.dev](https://melhome-bridge.votre-pseudo.workers.dev). Cliquez dessus.

Vous arrivez sur l'interface d'accueil de votre pont. Cliquez sur 🔐 Configurer MELCloud.

Entrez vos identifiants MELCloud Home et validez.

Si un message de succès s'affiche, cliquez sur 🌡️ Voir mes Clims.

Vous devriez voir vos climatiseurs apparaître avec la possibilité de les allumer ou les éteindre. Gardez l'URL de votre Worker sous la main, nous en avons besoin pour l'étape suivante.

🏠 Étape 5 : Configuration de l'Action Google Home
Il faut maintenant expliquer à Google comment discuter avec votre Worker.

Allez sur la Google Actions Console et connectez-vous avec votre compte Google.

Cliquez sur New Project, donnez-lui un nom (ex: "Mes Clims MELCloud"), choisissez votre langue/pays, puis cliquez sur Create project.

Sur la page suivante, choisissez Smart Home et cliquez sur Start Building.

Dans le menu de gauche, cliquez sur Actions.

Remplissez le champ Fulfillment URL avec l'adresse de votre Worker suivie de /google/fulfillment :

Exemple : [https://melhome-bridge.votre-pseudo.workers.dev/google/fulfillment](https://melhome-bridge.votre-pseudo.workers.dev/google/fulfillment)

Cliquez sur Save.

Dans le menu de gauche, allez dans Develop > Account linking. Remplissez les champs exactement comme suit :

Client ID : google

Client Secret : secret

Authorization URL : https://[VOTRE_URL_WORKER]/google/auth

Token URL : https://[VOTRE_URL_WORKER]/google/token

Laissez le reste par défaut et cliquez sur Save en haut à droite.

Allez dans l'onglet Test (en haut de l'écran) pour activer votre projet sur votre compte Google.

📱 Étape 6 : Association sur votre téléphone
C'est la dernière étape !

Ouvrez l'application Google Home sur votre smartphone.

Appuyez sur le bouton + en haut à gauche.

Choisissez Configurer un appareil > Fonctionne avec Google.

Dans la barre de recherche, tapez [test] Mes Clims MELCloud (ou le nom de votre projet).

Appuyez dessus. Une page s'ouvre vous demandant un code PIN.

Entrez le code par défaut : 1234 et validez.

Succès ! Google Home va synchroniser vos climatiseurs. Vous n'avez plus qu'à les assigner à vos pièces.

Vous pouvez maintenant piloter vos équipements à la voix : "Ok Google, allume le salon", "Ok Google, règle la température de la chambre sur 24 degrés".

🛠️ Dépannage & FAQ
Google Home me dit que l'appareil est indisponible.
Il est possible que votre jeton MELCloud ait été révoqué (par exemple si vous avez changé votre mot de passe sur l'application officielle).
Solution : Retournez sur l'URL de votre Worker Cloudflare, allez dans "Configurer MELCloud" et reconnectez-vous. Google Home refonctionnera immédiatement.

Où puis-je changer le code PIN "1234" ?
Si vous souhaitez sécuriser l'association, vous pouvez modifier la constante GOOGLE_HOME_PIN = "1234"; au tout début du code de votre Worker dans Cloudflare, puis redéployer.
