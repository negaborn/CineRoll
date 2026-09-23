declare module 'utif' {
  interface IFD {
    width: number;
    height: number;
    [key: string]: unknown;
  }

  function decode(buffer: ArrayBuffer): IFD[];
  function decodeImage(buffer: ArrayBuffer, ifd: IFD, ifds?: IFD[]): void;
  function toRGBA8(ifd: IFD): Uint8Array;

  const UTIF: { decode: typeof decode; decodeImage: typeof decodeImage; toRGBA8: typeof toRGBA8 };
  export default UTIF;
}
