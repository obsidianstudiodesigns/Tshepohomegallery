# Tshepo HOME Gallery

Website for Tshepo HOME Gallery, a professional gallery artist: paintings on walls, cars, clothes and canvas, and portraits drawn from photos.

**Live:** https://obsidianstudiodesigns.github.io/Tshepohomegallery/

The homepage is a scroll-driven 3D gallery walk built with three.js: spotlit canvases with brushstroke relief, a reflective concrete floor, and museum labels for each work.

## Structure

- `site/`: the deployed static site (plain HTML, CSS, JS; no build step)
  - `works.js`: the collection; array order is the hanging order on the 3D wall
  - `gallery3d.js`: the 3D scene
  - `assets/tex/`: pre-baked 3D textures (generated, do not edit by hand)
- `tools/bake_textures.py`: regenerates `assets/tex/` from `assets/works/`. Run it after adding or changing an artwork image: `python tools/bake_textures.py`

## Deploying

GitHub Pages serves the `gh-pages` branch, which holds the contents of `site/`. After committing to `main`:

```bash
git subtree push --prefix site origin gh-pages
```

## Local preview

The 3D scene needs a web server (not `file://`):

```bash
python -m http.server 8000 --directory site
```
