export const dailyNoteResourcePath = "data/daily-note/resources";
export const dailyNoteSourceRevision = "e28c6df5fd6212ce5943b4a9f7fba6e2bca32653";

// Original Lotus-ReFactor daily-note-summary assets. Keep the original paths inside the local theme.
export const dailyNoteFonts = {
  body: ["miao-theme/fonts/HYWH-65W.ttf", 3155072, "809ab0683bff573c55305c2c723c1692c64d6ecfdb78620b6b99d7a66d662dff"],
  number: ["source-templates/miao-stat/fonts/tttgbnumber.ttf", 20056, "2397a53ac610214da8a6823968c9573c99704b767759d9781707cdb4efde1005"],
  miSans: ["fonts/MiSans-VF.ttf", 20000736, "5daf8d5447bfd423cfdec94a0e07c53b205892223ccc6ea21b7b8a37248b44d9"],
} as const;

export const dailyNoteIcons = {
  树脂: ["source-templates/genshin/note-icons/gs/树脂.png", 2039, "785d2c7ae3db6fcef67dbd52c7defa18a1d22292c475a1eb07482294b3a92b52"],
  洞天宝钱: ["source-templates/genshin/note-icons/gs/洞天宝钱.png", 1822, "f0ac130be40dd3d38025c527d9e27c5fd7dcc4eb8a42ea04caaddcd20ff90e07"],
  委托: ["source-templates/genshin/note-icons/gs/委托.png", 1948, "fee48af414a9cb5083de09c3834ed2d53f5455fbecde021a2d48b7a6a537ffde"],
  派遣: ["source-templates/genshin/note-icons/gs/派遣.png", 8091, "8a5daea24a26cca3d92a83f6367b18d1f755118c32d0ee1668b54331fbbe93c2"],
  周本: ["source-templates/genshin/note-icons/gs/周本.png", 991, "7899305b74a4bad2bcfe3f05f348185727a4cf684f6725c2939bd4aff0d7d7e3"],
  参量质变仪: ["source-templates/genshin/note-icons/gs/参量质变仪.png", 2084, "6e1a454a3143106e5b1d03dc8a88a4e9738f8c1a1101e310a588e3c49f35f4f6"],
} as const;

export const dailyNoteAssets = [...Object.values(dailyNoteFonts), ...Object.values(dailyNoteIcons)];
