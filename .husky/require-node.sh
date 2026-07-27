#!/usr/bin/env sh
# Garde de version, partagé par les hooks.
#
# Sur un Node antérieur à 22.12, jsdom échoue sur `require()` d'un module ES : la
# suite rend trois échecs sans rapport apparent avec la cause. Le diagnostic prend
# alors dix minutes pour une commande à taper. Autant le dire tout de suite.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

if [ "$NODE_MAJOR" -lt 22 ]; then
  echo ""
  echo "  Node $(node -v 2>/dev/null || echo 'introuvable') détecté, or ce projet exige Node 22+."
  echo "  Le dépôt porte un .nvmrc :"
  echo ""
  echo "      fnm use      # ou : nvm use"
  echo ""
  echo "  (jsdom 30 a besoin de require(ESM), arrivé en Node 22.12.)"
  echo ""
  exit 1
fi
