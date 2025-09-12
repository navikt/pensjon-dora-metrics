FROM node:22.19.0-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY . .
RUN --mount=type=secret,id=github_token,required=true,env=GITHUB_TOKEN \
    node fetchDeployInfoFromGithub.ts
CMD ["node", "job.ts"]
