from PIL import Image, ImageDraw

# Create favicon with dark navy background and two smiley faces
width, height = 256, 256
img = Image.new('RGBA', (width, height), (45, 62, 80, 255))

# Create circular mask
mask = Image.new('L', (width, height), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.ellipse([0, 0, width-1, height-1], fill=255)

# Create faces layer
face = Image.new('RGBA', (width, height), (255, 255, 255, 0))
draw = ImageDraw.Draw(face)

# Left smiley
left_x, left_y = 40, 65
draw.ellipse([left_x, left_y, left_x+65, left_y+65], fill=(255, 255, 255))
draw.ellipse([left_x+15, left_y+22, left_x+25, left_y+32], fill=(45, 62, 80))
draw.ellipse([left_x+40, left_y+22, left_x+50, left_y+32], fill=(45, 62, 80))
draw.arc([left_x+12, left_y+35, left_x+53, left_y+58], 0, 180, fill=(45, 62, 80), width=5)

# Right smiley (bigger, overlapping)
right_x, right_y = 95, 45
draw.ellipse([right_x, right_y, right_x+80, right_y+80], fill=(255, 255, 255))
draw.ellipse([right_x+18, right_y+28, right_x+30, right_y+40], fill=(45, 62, 80))
draw.ellipse([right_x+50, right_y+28, right_x+62, right_y+40], fill=(45, 62, 80))
draw.arc([right_x+15, right_y+42, right_x+65, right_y+68], 0, 180, fill=(45, 62, 80), width=5)

# Small circle accent on right
draw.ellipse([175, 145, 200, 170], outline=(45, 62, 80), width=4)

# Apply mask
img.paste(face, (0, 0), mask)
img.save('assets/logo.png', 'PNG')
print('Favicon created successfully!')
