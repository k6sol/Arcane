import {createCipheriv,createDecipheriv,createHmac,randomBytes} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AccountsConfig} from './account-config.ts';

export const ACCOUNT_SCHEMA = `
CREATE TABLE account_identities (subject TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
 email_hash TEXT NOT NULL, email_cipher TEXT NOT NULL, mfa_required INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account_roles (subject TEXT PRIMARY KEY REFERENCES account_identities(subject), role TEXT NOT NULL CHECK(role='owner'), created_at INTEGER NOT NULL);
CREATE TABLE account_browser_sessions (hash TEXT PRIMARY KEY, subject TEXT, payload TEXT NOT NULL, version INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX account_browser_subject ON account_browser_sessions(subject);
CREATE TABLE account_device_approvals (device_id TEXT PRIMARY KEY REFERENCES device_requests(id), subject TEXT NOT NULL,
 aal TEXT NOT NULL, approved_at INTEGER NOT NULL);
CREATE TABLE account_token_access (hash TEXT PRIMARY KEY REFERENCES tokens(hash), subject TEXT NOT NULL, aal TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE account_bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1), subject TEXT NOT NULL, created_at INTEGER NOT NULL);
`;

export interface BrowserSession {
  hash: string; version: number; subject: string | null; expiresAt: number;
  data: {csrf:string;createdAt:number;accessToken?:string;refreshToken?:string;
    flow?:{nonce:string;verifier:string;provider:'google'|'apple'};
    recovery?:boolean};
}
export class AccountStorageError extends Error { constructor(){super('Account session is unavailable. Reload and try again.');} }

export class AccountStore {
  db: DatabaseSync; config: AccountsConfig; key: Buffer;
  constructor(db:DatabaseSync,config:AccountsConfig){this.db=db;this.config=config;this.key=Buffer.from(config.sessionKey,'base64url');}
  hash(kind:string,value:string):string{return createHmac('sha256',this.key).update(kind+'\0'+value).digest('hex');}
  seal(kind:string,id:string,value:unknown):string {
    const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>32768)throw new AccountStorageError();
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from('arcane-account-v1\0'+kind+'\0'+id));
    const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);return 'v1.'+Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');
  }
  open<T>(kind:string,id:string,value:string):T {
    try{
      if(typeof value!=='string'||value.length>45000||!/^v1\.[A-Za-z0-9_-]+$/.test(value))throw new AccountStorageError();
      const bytes=Buffer.from(value.slice(3),'base64url');if(bytes.length<29)throw new AccountStorageError();
      const cipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));cipher.setAAD(Buffer.from('arcane-account-v1\0'+kind+'\0'+id));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')) as T;
    }catch{throw new AccountStorageError();}
  }
  create(now:number,data?:BrowserSession['data'],subject:string|null=null):{cookie:string;session:BrowserSession} {
    const cookie=randomBytes(32).toString('base64url'),hash=this.hash('browser',cookie);
    const session:BrowserSession={hash,version:1,subject,expiresAt:now+(subject?30*86400000:15*60000),data:data??{csrf:randomBytes(32).toString('base64url'),createdAt:now}};
    this.db.prepare('INSERT INTO account_browser_sessions (hash,subject,payload,version,expires_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(hash,subject,this.seal('browser',hash,session.data),session.version,session.expiresAt,now);
    return {cookie,session};
  }
  read(cookie:string|undefined,now:number):BrowserSession|null {
    if(!cookie||! /^[A-Za-z0-9_-]{43}$/.test(cookie))return null;
    const hash=this.hash('browser',cookie),row=this.db.prepare('SELECT * FROM account_browser_sessions WHERE hash=? AND expires_at>?').get(hash,now);
    if(!row)return null;
    const data=this.open<BrowserSession['data']>('browser',hash,String(row.payload));
    if(!data||typeof data.csrf!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(data.csrf)||!Number.isSafeInteger(data.createdAt))throw new AccountStorageError();
    return {hash,version:Number(row.version),subject:row.subject===null?null:String(row.subject),expiresAt:Number(row.expires_at),data};
  }
  save(session:BrowserSession,now:number):void {
    const result=this.db.prepare('UPDATE account_browser_sessions SET subject=?,payload=?,version=version+1,updated_at=? WHERE hash=? AND version=? AND expires_at>?')
      .run(session.subject,this.seal('browser',session.hash,session.data),now,session.hash,session.version,now);
    if(Number(result.changes)!==1)throw new AccountStorageError();session.version++;
  }
  remove(hash:string):void {this.db.prepare('DELETE FROM account_browser_sessions WHERE hash=?').run(hash);}
  sweep(now:number):void {this.db.prepare('DELETE FROM account_browser_sessions WHERE expires_at<=?').run(now);}
}
