This folder is what a node image built without CI's APK step holds at /beanpool-apk (see the Dockerfile's `apk` stage).

An image built by .github/workflows/docker-publish.yml holds the newest checked Android APK here instead, with its
apk.json. A node whose image holds none fetches the APK into data/apk/ once it is online (apps/server/src/services/apk-mirror.ts).
