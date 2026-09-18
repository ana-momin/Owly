// Downscale logo.png into the sizes a site needs, using the Chromium that is
// already installed for the tests rather than adding an image dependency.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const src = `data:image/png;base64,${readFileSync("logo.png").toString("base64")}`;
const sizes = [512, 192, 180, 64, 32];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<body></body>");
for (const size of sizes) {
  const url = await page.evaluate(
    async ([src, size]) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, size, size);
      return c.toDataURL("image/png");
    },
    [src, size],
  );
  const out = size === 512 ? "public/logo.png" : `public/icon-${size}.png`;
  const bytes = Buffer.from(url.split(",")[1], "base64");
  writeFileSync(out, bytes);
  console.log(out, size, `${(bytes.length / 1024).toFixed(1)}KB`);
}
await browser.close();
