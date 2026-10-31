/** Stable public error references. Correlation IDs stay separate from these explanations. */
export interface UserError {readonly number:number;readonly title:string;readonly explanation:string;readonly nextStep:string}
const entry=(number:number,title:string,explanation:string,nextStep:string):UserError=>Object.freeze({number,title,explanation,nextStep});
export const USER_ERRORS=Object.freeze({
  411:entry(411,'Connection message exceeded a limit','A message on the local ChatGPT connection exceeded the size Arcane can accept. Its outcome is unconfirmed.','Check the recorded status before trying again. Nothing is resent automatically.'),
  412:entry(412,'Earlier tasks need review','Arcane has not confirmed how earlier tasks finished. Their records are kept.','Review those task records before acknowledging this notice. Reconnecting does not settle them.'),
  413:entry(413,'Sign-in required','The selected provider has not confirmed a usable account session.','Continue with the provider sign-in and finish in your browser.'),
  414:entry(414,'Sign-in could not be confirmed','Arcane did not receive a confirmed sign-in result.','Check sign-in status before starting another login. Your previous account is not signed out automatically.'),
  415:entry(415,'Connection unavailable','The required connection is not available for this operation.','Check the connection status and the selected provider.'),
  416:entry(416,'Workspace changed','The workspace or connection changed while the operation was being checked.','Return to the intended workspace and check its current status.'),
  421:entry(421,'Request outcome unconfirmed','Arcane could not confirm whether the request completed.','Check its recorded status. Do not resend it until the original outcome is understood.'),
  422:entry(422,'Operation timed out','The operation exceeded its time limit.','Check its recorded outcome and cleanup status before retrying.'),
  423:entry(423,'Saved state unavailable','Arcane could not save or verify the required local records.','Keep unsent work in this window and check storage availability.'),
  431:entry(431,'Model generation failed','The model could not complete its generation stage.','Read the failing stage and reason below before starting another generation.'),
  432:entry(432,'Mesh validation failed','The generated geometry did not pass its structural checks.','Inspect the mesh validation report and correct the failed checks.'),
  433:entry(433,'Material validation failed','A model material or shader did not pass its required checks.','Inspect the material report for the missing shader, connection or PBR value.'),
  434:entry(434,'Texture generation failed','The texture stage could not produce a validated result.','Read the texture-stage details before generating again.'),
  435:entry(435,'Model export failed','The model export or round-trip verification did not complete successfully.','Review the export-stage details before importing the model.'),
  436:entry(436,'Studio import unconfirmed','Arcane could not confirm that the intended import completed.','Check the recorded import phase and target. Placement is not proof of an uploaded asset.'),
  437:entry(437,'Preview unavailable','The model preview could not be opened or verified.','Check the model export and validation report. Your chat and model records are kept.'),
  438:entry(438,'Permission required','The operation does not have its required permission.','Review the permission for this exact task before continuing.'),
  499:entry(499,'Operation could not complete','Arcane could not confirm a successful result for this operation.','Read the operation details and check its recorded outcome before trying again.'),
});
export type UserErrorNumber=keyof typeof USER_ERRORS;
const CODES:Readonly<Record<string,UserErrorNumber>>=Object.freeze({
  FRAME_LIMIT:411,NATIVE_FRAME_LIMIT:411,TASK_RECOVERY_REQUIRED:412,AUTH_REQUIRED:413,AUTH:413,
  LOGIN_UNCONFIRMED:414,DISCONNECTED:415,CONNECTION_UNAVAILABLE:415,STALE_CONNECTION:416,STALE_CONTEXT:416,
  OUTCOME_UNKNOWN:421,TIMEOUT:422,DEADLINE:422,REQUEST_TIMEOUT:422,JOURNAL_FAILURE:423,STORAGE_UNAVAILABLE:423,
  MESH_AUDIT:432,MESH_REPAIR:432,MESH_MATERIAL_NODE:433,MESH_MATERIAL_LINK:433,MESH_MATERIAL_SURFACE:433,MESH_MATERIAL_PBR:433,
  EXPORT_ROUNDTRIP:435,IMPORT_IDENTITY:435,STUDIO_STAGE_CONTINUITY:436,IMPORT_FAILED:436,PERMISSION_DENIED:438,APPROVAL_REJECTED:438,
});
export function userError(code:unknown,area:'general'|'model'|'preview'|'import'='general',stage?:unknown):UserError {
  if(typeof code==='string'&&Object.hasOwn(CODES,code))return USER_ERRORS[CODES[code]!];
  if(area==='preview')return USER_ERRORS[437];
  if(area==='import')return USER_ERRORS[436];
  if(area==='model')return USER_ERRORS[stage==='texture-authoring'?434:stage==='export'||stage==='export-roundtrip'||stage==='export-identity'?435:431];
  return USER_ERRORS[499];
}
export const userErrorLabel=(error:UserError):string=>'Error '+error.number+' · '+error.title;
export const userErrorText=(error:UserError):string=>userErrorLabel(error)+'. '+error.explanation+' '+error.nextStep;
