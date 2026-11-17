"""Conservative, deterministic car-paint estimation from public advert photographs.

No ML models, external colour-recognition services or image uploads. With only a
lead photograph, unsegmented backgrounds can dominate; reject uncertain images
instead of treating scenery as a verified paint colour.
"""
import colorsys
from collections import Counter
from PIL import Image, ImageOps, ImageStat

COLOURS = ('red', 'orange', 'yellow', 'green', 'blue', 'purple',
           'black', 'grey', 'silver', 'white')


def hue_colour(h):
    """Approximate traditional HSV paint hue boundaries (h is 0..1)."""
    if h < 0.035 or h >= 0.965:
        return 'red'
    if h < 0.105:
        return 'orange'
    if h < 0.18:
        return 'yellow'
    if h < 0.47:
        return 'green'
    if h < 0.735:
        return 'blue'
    if h < 0.89:
        return 'purple'
    return 'red'


def estimate_paint(image):
    """Return {'colour': str, 'confidence': float} or None.

    Inspect mostly the central/lower bodywork footprint. Large and coherent
    paint-coloured areas are more convincing than a few colourful pixels; the
    result deliberately favours an unknown over a wrong paint estimate.
    """
    try:
        rgb = ImageOps.exif_transpose(image).convert('RGB').resize((120, 96), Image.Resampling.BILINEAR)
    except (OSError, ValueError, Image.DecompressionBombError):
        return None

    # Solid colour placeholders are not useful evidence of vehicle paint.
    if ImageStat.Stat(rgb.convert('L')).stddev[0] < 9:
        return None
    pixels = rgb.load()
    # Region roughly containing the doors/bonnet in usual advert photos.
    # Avoid much of the sky above and the road beneath the car.
    x1, x2 = 22, 99
    y1, y2 = 29, 75
    histogram = Counter()
    neutral = Counter()
    vivid = 0
    samples = 0
    tile_votes = Counter()
    tile_total = Counter()
    for y in range(y1, y2):
        for x in range(x1, x2):
            r, g, b = pixels[x, y]
            h, s, v = colorsys.rgb_to_hsv(r/255, g/255, b/255)
            tile = (min(3, (x - x1)*4//(x2-x1)), min(2, (y-y1)*3//(y2-y1)))
            samples += 1
            if s >= 0.25 and (s >= 0.35 or v >= 0.42) and 0.17 <= v <= 1.0:
                colour = hue_colour(h)
                vivid += 1
                histogram[colour] += 1
                tile_votes[(tile, colour)] += 1
            elif s <= 0.12:
                if v < 0.23:
                    neutral['black'] += 1
                elif v > 0.88:
                    neutral['white'] += 1
                elif v > 0.68:
                    neutral['silver'] += 1
                else:
                    neutral['grey'] += 1
            tile_total[tile] += 1

    if histogram:
        primary, count = histogram.most_common(1)[0]
        second = histogram.most_common(2)[1][1] if len(histogram) > 1 else 0
        # Requiring agreement across multiple neighbouring blocks reduces
        # false 'green' from grass, and blue from sky or reflections.
        coherent = sum(1 for tile, total in tile_total.items()
                       if tile_votes[(tile, primary)] / total >= 0.48)
        share = count / samples
        separation = (count-second) / max(1, vivid)
        if share >= 0.38 and separation >= 0.55 and coherent >= 4:
            confidence = min(.94, .66 + .20 * min(1., share/.64)
                             + .10 * separation + .02 * (coherent/12))
            return {'colour': primary, 'confidence': round(confidence, 3)}

    # Neutrals are less trustworthy (black paint, glass, shadow and dark
    # asphalt can look alike). Return only unusually dominant neutral fields.
    if neutral:
        primary, count = neutral.most_common(1)[0]
        next_count = neutral.most_common(2)[1][1] if len(neutral) > 1 else 0
        share = count / samples
        if share >= 0.55 and next_count / samples <= 0.10 and vivid/samples < 0.10:
            return {'colour': primary, 'confidence': round(min(.91, .79 + share*.13), 3)}
    return None
