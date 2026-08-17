import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

import env from "./env.js";

let firestore = null;

const getFirebaseApp = () => {
  return getApps()[0] ?? initializeApp({
    credential: applicationDefault(),
    ...(env.firebase.projectId ? { projectId: env.firebase.projectId } : {}),
  });
};

export const getFirestoreDb = () => {
  if (firestore) return firestore;
  firestore = getFirestore(getFirebaseApp());
  return firestore;
};

export const getFirebaseAuth = () => getAuth(getFirebaseApp());
