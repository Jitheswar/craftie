#!/usr/bin/env bash
# Builds the Craftie mod for several Minecraft versions from Fabric's official per-version templates.
# Usage: ./build-versions.sh 1.20.1 1.20.4 1.21.1 1.21.4 26.3   (needs git and Java 25+)
#
# autolan-fabric/src is the whole mod as it is for 1.20.1. What differs in newer versions is a
# set of files in autolan-fabric/compat/<since-version>/, copied over the top:
#   compat/1.20.5  from 1.20.5: a renamed Minecraft method
#   compat/26      from 26.x: new LAN and chat calls, plus the status HUD, order key, /craftie and skin
set -u
cd "$(dirname "$0")"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-27-openjdk}"
MOD_VERSION=1.1.0

# Which compat folder a Minecraft version needs ("" = none).
compat_for() {
  local major minor patch
  major=$(echo "$1" | cut -d. -f1); minor=$(echo "$1" | cut -d. -f2); patch=$(echo "$1" | cut -d. -f3)
  if [ "$major" -ge 26 ]; then echo 26
  elif [ "$minor" -gt 20 ] || { [ "$minor" -eq 20 ] && [ "${patch:-0}" -ge 5 ]; }; then echo 1.20.5
  fi
}

for v in "$@"; do
  echo "=== $v"
  if [ "$v" = 1.20.1 ]; then # autolan-fabric is itself the 1.20.1 project
    sed -i "s/^version=.*/version=$MOD_VERSION/" autolan-fabric/gradle.properties
    if (cd autolan-fabric && ./gradlew build --no-daemon -q > ../build-$v.log 2>&1); then
      cp "autolan-fabric/build/libs/craftie-autolan-$MOD_VERSION.jar" "builds/craftie-autolan-$v.jar" && echo "OK $v"
    else
      echo "FAILED $v (see mods/build-$v.log)"; grep -E "error:" build-$v.log | head -8
    fi
    continue
  fi
  rm -rf "work-$v"
  git clone -q --depth 1 -b "$v" https://github.com/FabricMC/fabric-example-mod "work-$v" || { echo "no template for $v"; continue; }
  cd "work-$v"
  # Keep the template's build setup, replace its example code with ours.
  rm -rf .git src
  cp -r ../autolan-fabric/src src
  compat=$(compat_for "$v")
  [ -n "$compat" ] && cp -r "../autolan-fabric/compat/$compat/." src/
  java_rel=$(grep -oE "options.release = [0-9]+" build.gradle | grep -oE "[0-9]+")
  sed -i "s/\"minecraft\": \"~1.20.1\"/\"minecraft\": \"~$v\"/; s/\"java\": \">=17\"/\"java\": \">=${java_rel:-17}\"/" src/main/resources/fabric.mod.json
  sed -i 's/"modid" {/"craftie_autolan" {/' build.gradle
  sed -i "s/rootProject.name = .*/rootProject.name = 'craftie-autolan'/" settings.gradle
  sed -i "s/^\\(mod_\\)\\?version *=.*/\\1version=$MOD_VERSION/" gradle.properties
  if ./gradlew build --no-daemon -q > ../build-$v.log 2>&1; then
    cp build/libs/craftie-autolan-*[0-9].jar "../builds/craftie-autolan-$v.jar" && echo "OK $v"
  else
    echo "FAILED $v (see mods/build-$v.log)"; grep -E "error:" ../build-$v.log | head -8
  fi
  cd ..
done
