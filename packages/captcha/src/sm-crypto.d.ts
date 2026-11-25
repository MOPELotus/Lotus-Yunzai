// The host's older media module declares only sm3. Merge the installed library's
// existing sm2/sm4 exports without changing that module's implementation or types.
import 'sm-crypto'
declare module 'sm-crypto' {
  export namespace sm2 {
    function doEncrypt(message: string | ArrayLike<number>, publicKey: string, cipherMode?: 0 | 1): string
  }
  export namespace sm4 {
    function encrypt(message: number[], key: number[], options: {
      mode: 'cbc'; iv: number[]; padding: 'pkcs#7'
    }): string
  }
}
