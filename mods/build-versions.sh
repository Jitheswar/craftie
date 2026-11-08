#!/usr/bin/env bash
# Builds Craftie Auto LAN for several Minecraft versions from Fabric's official per-version templates.
# Usage: ./build-versions.sh 1.20.4 1.21.1 1.21.4   (needs git and Java 25+)
set -u
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-27-openjdk}"
for v in "$@"; do
  echo "=== $v"
  rm -rf "work-$v"
  git clone -q --depth 1 -b "$v" https://github.com/FabricMC/fabric-example-mod "work-$v" || { echo "no template for $v"; continue; }
  cd "work-$v"
  rm -rf .git src/main/java src/client/java src/client/resources src/main/resources/*.mixins.json
  mkdir -p src/client/java/dev/craftie/autolan src/main/resources/assets/craftie_autolan
  cp ../autolan-fabric/src/client/java/dev/craftie/autolan/AutoLan.java src/client/java/dev/craftie/autolan/
  # Names that changed between Minecraft versions (Mojang mappings).
  minor=$(echo "$v" | cut -d. -f2); patch=$(echo "$v" | cut -d. -f3); patch=${patch:-0}
  if [ "$minor" -gt 20 ] || { [ "$minor" -eq 20 ] && [ "$patch" -ge 5 ]; }; then
    sed -i 's/isAllowCheatsForAllPlayers/isAllowCommandsForAllPlayers/' src/client/java/dev/craftie/autolan/AutoLan.java
  fi
  cp ../autolan-fabric/src/main/resources/assets/craftie_autolan/icon.png src/main/resources/assets/craftie_autolan/
  sed "s/\"minecraft\": \"~1.20.1\"/\"minecraft\": \"~$v\"/" ../autolan-fabric/src/main/resources/fabric.mod.json > src/main/resources/fabric.mod.json
  rm -rf src/main/resources/assets/modid
  sed -i 's/"modid" {/"craftie_autolan" {/' build.gradle
  sed -i "s/rootProject.name = .*/rootProject.name = 'craftie-autolan'/" settings.gradle
  java_rel=$(grep -oE "options.release = [0-9]+" build.gradle | grep -oE "[0-9]+")
  sed -i "s/\"java\": \">=17\"/\"java\": \">=${java_rel:-17}\"/" src/main/resources/fabric.mod.json
  if ./gradlew build --no-daemon -q > ../build-$v.log 2>&1; then
    cp build/libs/craftie-autolan-*[0-9].jar "../builds/craftie-autolan-$v.jar" && echo "OK $v"
  else
    echo "FAILED $v (see mods/build-$v.log)"; grep -E "error:" ../build-$v.log | head -8
  fi
  cd ..
done
