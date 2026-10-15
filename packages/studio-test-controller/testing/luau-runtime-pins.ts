// Test-only official release pins shared by the Node 24 installer and compiled fixtures.
export const LUAU_TEST_RELEASE=Object.freeze({version:'0.742',commit:'8387cfb461b38ce09e37c1e4c2811538ef1bf5cb',
  source:'https://github.com/luau-lang/luau/releases/tag/0.742',
  metadata:'https://api.github.com/repos/luau-lang/luau/releases/tags/0.742'});
export const LUAU_TEST_PINS=Object.freeze({
  win32:Object.freeze({assetId:626558808,archive:'luau-windows.zip',bytes:3190105,sha256:'1114966cd8198f407069f07e8b4e6bacf2ded933e4a57d6ddc75617969278c75',
    runtime:Object.freeze({name:'luau.exe',bytes:1670656,sha256:'4e86c0399aca661753d918bb775a152e35fd8f7a788b67076e1e03f81bc43703'}),
    compiler:Object.freeze({name:'luau-compile.exe',bytes:1403904,sha256:'74cf7ed3621b8966bac6fec7f1a0caf13616655fa06d346133cd31f6aac439d8'})}),
  linux:Object.freeze({assetId:626557066,archive:'luau-ubuntu.zip',bytes:7684030,sha256:'152058b98c60ff1f5b5ec9bca0b8eb37793cae161dd3a05608cc3d8738ba1a4d',
    runtime:Object.freeze({name:'luau',bytes:3038288,sha256:'13c600d000a354fcccda705653bd803e65513aee610a1f83e02c5e98f84ebb32'}),
    compiler:Object.freeze({name:'luau-compile',bytes:2611400,sha256:'8e13ed98aa01f0a5e51710656b36c93e611e0a3c6cbf4f6eec2e4aac878b0fd5'})}),
});
