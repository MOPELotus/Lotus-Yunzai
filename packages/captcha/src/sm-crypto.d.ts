// The host's older media module declares only sm3. Merge the installed library's
// existing sm2 export without changing that module's implementation or types.
import 'sm-crypto'
declare module 'sm-crypto' {
  export namespace sm2 {
    function doEncrypt(message: string | ArrayLike<number>, publicKey: string, cipherMode?: 0 | 1): string
  }
}
