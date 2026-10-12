# Hosting on TrueNAS with Dockge and Nginx Proxy Manager

This guide runs the portfolio as a Dockge stack on TrueNAS, behind an Nginx Proxy Manager (NPM) container that serves your domain over HTTPS.

```
GitHub (push to main) ──► GitHub Actions builds the image ──► ghcr.io/vinnesttree/portfolio
                                                                        │ pull
Internet ──► router :80/:443 ──► Nginx Proxy Manager ──► portfolio container (Dockge stack)
```

GitHub builds the image, so the NAS needs no source code, Git or build tools. Dockge only pulls and runs the finished image. Updating the site later is a push to `main` followed by one click in Dockge.

## What you need

- TrueNAS 24.10 (Electric Eel) or later, which runs apps on Docker, with Dockge installed.
- Nginx Proxy Manager running in its own container, with your router forwarding ports 80 and 443 to it.
- A domain whose DNS `A` record points at your public IP address.
- The site's code on the `main` branch of this repository.

## 1. Publish the image (once)

1. Push or merge to `main`. The **Container image** workflow in `.github/workflows/container-image.yml` runs the tests, builds the image and publishes it as `ghcr.io/vinnesttree/portfolio:latest`. Check that the run turns green on the repository's **Actions** tab.
2. Make the package public so Dockge can pull it without logging in. On GitHub, open your profile → **Packages** → **portfolio** → **Package settings** → **Danger Zone** → **Change visibility** → **Public**.

   The image only contains the website files, which are public once the site is live anyway. The repository itself stays private.

<details>
<summary>Keeping the package private instead</summary>

Dockge pulls images with its own Docker client, so the login has to happen inside the Dockge container. Create a GitHub personal access token (classic) with only the `read:packages` scope. Then run this in the TrueNAS shell and paste the token when asked for a password:

```sh
sudo docker exec -it "$(sudo docker ps -qf name=dockge)" docker login ghcr.io -u vinnesttree
```

The login is stored inside the Dockge container, so you may need to repeat it after Dockge is updated or reinstalled.
</details>

## 2. Choose how NPM reaches the site

| Your NPM runs as… | Use | NPM forwards to |
| --- | --- | --- |
| A Dockge stack, or any compose stack you can edit | **Option A: shared network** (recommended) | `portfolio`, port `8080` |
| A TrueNAS catalog app, or you'd rather not edit it | **Option B: host port** | your TrueNAS IP, port `8085` |

**Option A** keeps the site off your LAN entirely: NPM reaches the container by name over a private Docker network. **Option B** publishes the site on a port of the NAS and works with any NPM setup.

### Option A: shared network

1. Create the network once. In TrueNAS, open **System → Shell** and run:

   ```sh
   sudo docker network create proxy
   ```

   If NPM is already on a shared network you use for other sites, skip this and use that network's name instead of `proxy` below.

2. Attach NPM to it. In Dockge, open your NPM stack, click **Edit**, and add the `networks` lines below. Your service name may differ from `app`. Keep `default` in the list, because NPM's database (if it has one) is on that network. Then click **Deploy**.

   ```yaml
   services:
     app:
       # ...your existing NPM settings stay as they are...
       networks:
         - default
         - proxy

   networks:
     proxy:
       external: true
   ```

### Option B: host port

Nothing to prepare. Pick a free port on the NAS for the site; this guide uses `8085`. Avoid 80 and 443 and any port another app already uses.

## 3. Create the stack in Dockge

In Dockge, click **+ Compose**, enter `portfolio` as the **Stack Name**, and replace the YAML in the editor with one of the following. Then click **Deploy**.

**Option A: shared network**

```yaml
services:
  portfolio:
    image: ghcr.io/vinnesttree/portfolio:latest
    container_name: portfolio
    restart: unless-stopped
    networks:
      - proxy
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true

networks:
  proxy:
    external: true
```

**Option B: host port**

```yaml
services:
  portfolio:
    image: ghcr.io/vinnesttree/portfolio:latest
    container_name: portfolio
    restart: unless-stopped
    ports:
      - "8085:8080" # change 8085 if that port is taken; keep 8080
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

After a few seconds the container should show a green **healthy** badge. With Option B you can check it from your LAN at `http://<truenas-ip>:8085`.

Paste the whole YAML rather than using Dockge's **External Networks** switch. The switch only declares the network; it doesn't attach the container to it.

## 4. Add the proxy host in Nginx Proxy Manager

In NPM, go to **Hosts → Proxy Hosts → Add Proxy Host**.

**Details** tab:

| Field | Option A | Option B |
| --- | --- | --- |
| Domain Names | `aroeser.com` (press Enter), and `www.aroeser.com` if you want it | same |
| Scheme | `http` | `http` |
| Forward Hostname / IP | `portfolio` | your TrueNAS LAN IP, e.g. `192.168.1.10` |
| Forward Port | `8080` | `8085` |

Turn on **Block Common Exploits**. Leave **Cache Assets** off, because the site already sends its own caching headers, and **Websockets Support** isn't needed.

**SSL** tab: set **SSL Certificate** to **Request a new Certificate** (Let's Encrypt), and turn on **Force SSL** and **HTTP/2 Support**. Turn on **HSTS Enabled** only once HTTPS is working, because browsers remember it.

Click **Save**. Let's Encrypt has to reach NPM on port 80 from the internet, so the DNS record and router port forwarding must already be in place.

## Updating the site

1. Change the content (for example `site/content/*.json`) and push to `main`. For LinkedIn content, run the importer on your computer first, as described in the [README](../README.md#adding-your-linkedin-content), and commit the updated `linkedin.json`.
2. Wait for the **Container image** run on GitHub to finish, which takes a minute or two.
3. In Dockge, open the **portfolio** stack and click **Update**. This pulls the new image and recreates the container.

To roll back, change the image tag in the stack from `latest` to an earlier build's tag, such as `sha-1a2b3c4`, and click **Deploy**. Every build is tagged with its commit, and the tags are listed on the package's page on GitHub.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Deploy fails with `denied` or `unauthorized` | The package is still private. Make it public (step 1), or log Dockge in to GHCR. |
| Deploy fails with `manifest unknown` or `not found` | The image hasn't been published yet. Check that the **Container image** run on `main` succeeded. |
| NPM shows **502 Bad Gateway** (Option A) | NPM and the portfolio container aren't on the same network. Run `sudo docker network inspect proxy` and check that both containers are listed. Forward to port `8080`, the container's own port. |
| NPM shows **502 Bad Gateway** (Option B) | Forward to the TrueNAS LAN IP and the host port (`8085`), not `localhost`, because `localhost` inside NPM is NPM itself. |
| `port is already allocated` (Option B) | Another app uses that port. Change the left-hand number in `"8085:8080"`. |
| Project cards show no stars or "Updated" dates | The visitor's browser couldn't reach the GitHub API or hit its hourly limit. The cards still show; the live details return on a later visit. |

The container image is built for `linux/amd64`, which is what TrueNAS runs on.
