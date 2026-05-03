FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install
RUN npm install @tailwindcss/postcss

COPY . .

EXPOSE 5173