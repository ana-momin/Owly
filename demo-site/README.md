# Nimbus (Owly demo target)

A small, plausible-looking site whose signup always fails on the server and
whose sign-in form does nothing, so Owly has something real to fail on in a
public demo.

- `public/` - the site
- `api/signup.js` - returns HTTP 500 for every submission, on purpose
- `public/.well-known/owly-verification.txt` - lets Owly run a full test here

It is not connected to Nimbus, any real company, or any database. Nothing
submitted to it is read or stored.

## Deploying it

It is its own Vercel project (`owly-demo`), deployed from this folder, not from
git and not part of the Owly deployment:

```bash
cd demo-site && npx vercel deploy --prod
```

Live at https://owly-demo-rho.vercel.app. `public/demo-report.html` on the Owly
site is a saved copy of a real report of it.
