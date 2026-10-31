FROM node:22.23.4-alpine AS build_image

WORKDIR /app

ARG TARGETPLATFORM
ENV TARGETPLATFORM=${TARGETPLATFORM:-linux/amd64}

RUN apk add --no-cache \
  python3 make g++ gcc libc6-compat bash \
  build-base cairo-dev pango-dev jpeg-dev giflib-dev pixman-dev

RUN yarn global add node-gyp --ignore-engines

COPY package.json yarn.lock ./
RUN CYPRESS_INSTALL_BINARY=0 yarn install --frozen-lockfile --network-timeout 1000000

COPY . ./

ARG COMMIT_TAG
ENV COMMIT_TAG=${COMMIT_TAG}

RUN yarn build

# remove development dependencies
RUN yarn install --production --ignore-scripts --prefer-offline

RUN rm -rf src server .next/cache

RUN mkdir -p config && touch config/DOCKER

RUN echo "{\"commitTag\": \"${COMMIT_TAG}\"}" > committag.json


FROM node:22.23.4-alpine

WORKDIR /app

# google/fonts is fetched by commit so the files cannot change under the build
ARG GOOGLE_FONTS_REF=6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec

RUN apk add --no-cache \
  tzdata tini su-exec fontconfig ttf-dejavu font-noto-emoji \
  cairo pango jpeg giflib pixman \
  ffmpeg python3 \
  && mkdir -p /usr/share/fonts/truetype/poster-fonts && \
  cd /usr/share/fonts/truetype/poster-fonts && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/bebasneue/BebasNeue-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/anton/Anton-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/creepster/Creepster-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/bangers/Bangers-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/abrilfatface/AbrilFatface-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/lato/Lato-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/pacifico/Pacifico-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/greatvibes/GreatVibes-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/nosifer/Nosifer-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/bungee/Bungee-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/pressstart2p/PressStart2P-Regular.ttf && \
  wget -q https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/courierprime/CourierPrime-Regular.ttf && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/oswald/Oswald[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/fredoka/Fredoka[wdth,wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/playfairdisplay/PlayfairDisplay[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/montserrat/Montserrat[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/roboto/Roboto[wdth,wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/inter/Inter[opsz,wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/jetbrainsmono/JetBrainsMono[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/dancingscript/DancingScript[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/raleway/Raleway[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/orbitron/Orbitron[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/cinzel/Cinzel[wght].ttf" && \
  wget -q "https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_REF}/ofl/cormorantgaramond/CormorantGaramond[wght].ttf" && \
  wget -q https://github.com/tonsky/FiraCode/releases/download/6.2/Fira_Code_v6.2.zip && \
  echo "0949915ba8eb24d89fd93d10a7ff623f42830d7c5ffc3ecbf960e4ecad3e3e79  Fira_Code_v6.2.zip" | sha256sum -c - && \
  unzip -q Fira_Code_v6.2.zip && \
  mv ttf/FiraCode-Bold.ttf . && \
  rm -rf Fira_Code_v6.2.zip ttf/ woff/ woff2/ variable_ttf/ && \
  fc-cache -fv && \
  rm -rf /tmp/*

# Configure fontconfig to scan custom fonts directory
RUN mkdir -p /etc/fonts/conf.d && \
  echo '<?xml version="1.0"?>' > /etc/fonts/conf.d/99-agregarr-custom-fonts.conf && \
  echo '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' >> /etc/fonts/conf.d/99-agregarr-custom-fonts.conf && \
  echo '<fontconfig>' >> /etc/fonts/conf.d/99-agregarr-custom-fonts.conf && \
  echo '  <dir>/app/config/fonts</dir>' >> /etc/fonts/conf.d/99-agregarr-custom-fonts.conf && \
  echo '</fontconfig>' >> /etc/fonts/conf.d/99-agregarr-custom-fonts.conf

# Install Deno (yt-dlp JS runtime) from Alpine edge
RUN echo "@edge https://dl-cdn.alpinelinux.org/alpine/edge/main" >> /etc/apk/repositories && \
  echo "@edge https://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories && \
  apk add --no-cache deno@edge

# Install yt-dlp pinned release
RUN wget -q https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp -O /usr/local/bin/yt-dlp && \
  echo "e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3  /usr/local/bin/yt-dlp" | sha256sum -c - && \
  chmod a+rx /usr/local/bin/yt-dlp
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp

# Install Chromium and dependencies for Playwright
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont

COPY --from=build_image /app ./

# Entrypoint handles optional PUID/PGID privilege dropping
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Configure Playwright to use system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

ENTRYPOINT [ "/entrypoint.sh" ]
CMD [ "yarn", "start" ]

EXPOSE 7171
