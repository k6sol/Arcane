/** Internal save observation only. Fulfillment is not successful persistence. */
export type AssetSaveOutcome = Readonly<{ok:true}|{ok:false;error:unknown}>;

/** Capture one FIFO save without joining snapshots scheduled after this call.
 * A prior failure skips this write and retains the original outcome by identity.
 * The callback belongs to the original service, never an HTTP/MCP caller. */
export function captureAssetSave(previous:Promise<AssetSaveOutcome>,save:()=>Promise<void>):Promise<AssetSaveOutcome>{
  return previous.then(async outcome=>{
    if(!outcome.ok)return outcome;
    try{await save();const result:AssetSaveOutcome={ok:true};return Object.freeze(result);}
    catch(error){const result:AssetSaveOutcome={ok:false,error};return Object.freeze(result);}
  });
}
