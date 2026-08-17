import axios from "axios";
import env from "./env.js";

const unipileClient = axios.create({
  baseURL: env.unipile.baseUrl,
  timeout: env.unipile.timeout,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-API-KEY": env.unipile.apiKey,
  },
});

export default unipileClient;
