#!/bin/bash
set -e

SRC="ios/BeanPoolPillar/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png"
FG="assets/images/android-foreground.png"

echo "Creating Adaptive padding..."
# Create a 1536x1536 image with 000000 black background, containing the 1024x1024 icon centered.
sips -p 1536 1536 --padColor 000000 "$SRC" --out "$FG"

RES_DIR="android/app/src/main/res"

# Generate regular and round icons (just standard sci-fi bean)
for DPI in "mdpi:48" "hdpi:72" "xhdpi:96" "xxhdpi:144" "xxxhdpi:192"; do
    NAME=${DPI%%:*}
    SIZE=${DPI#*:}
    echo "Generating standard $NAME ($SIZE x $SIZE)..."
    sips -z $SIZE $SIZE "$SRC" --out "$RES_DIR/mipmap-$NAME/ic_launcher.png"
    sips -z $SIZE $SIZE "$SRC" --out "$RES_DIR/mipmap-$NAME/ic_launcher_round.png"
done

# Generate adaptive foreground icons (padded sci-fi bean)
for DPI in "mdpi:108" "hdpi:162" "xhdpi:216" "xxhdpi:324" "xxxhdpi:432"; do
    NAME=${DPI%%:*}
    SIZE=${DPI#*:}
    echo "Generating foreground $NAME ($SIZE x $SIZE)..."
    sips -z $SIZE $SIZE "$FG" --out "$RES_DIR/mipmap-$NAME/ic_launcher_foreground.png"
done

echo "Done"
