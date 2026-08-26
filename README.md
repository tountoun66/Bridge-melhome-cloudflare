# MELHome Bridge — Cloudflare

Bridge open source et **self-hosted** pour piloter MELCloud Home avec Google Home.

> Projet non officiel, indépendant de Mitsubishi Electric et de MELCloud.

## Objectif

Chaque utilisateur déploie sa propre instance Cloudflare Worker et son propre stockage D1. Aucun serveur central n'héberge les comptes des utilisateurs.

## Architecture

Google Home → Cloudflare Worker → MELCloud Home → climatiseurs

La version actuelle est une première migration du bridge Node/Express vers Cloudflare Workers. Elle conserve la logique MELCloud/Google Home existante et utilise D1 pour rendre la session persistante après un redémarrage du Worker.

## Installation

1. Créer un Worker Cloudflare.
2. Créer une base D1 nommée `melhome-bridge`.
3. Remplacer `database_id` dans `wrangler.jsonc` par l'identifiant de la base.
4. Exécuter le fichier `schema.sql` sur la base D1.
5. Installer les dépendances : `npm install`.
6. Tester : `npm run dev`.
7. Déployer : `npm run deploy`.

## Sécurité

Ne commitez jamais de cookie MELCloud, token OAuth ou secret personnel dans GitHub. La version finale doit remplacer le mécanisme de cookie de test par le flux OAuth MELCloud validé.

## Licence

À définir.
