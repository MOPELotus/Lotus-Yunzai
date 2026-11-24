import { prepareFixedTheme, type FixedThemeOptions } from "./fixed-theme.ts";

const resourcePath = "data/zzz/gacha-theme";
const theme = {
  resourcePath,
  sourceRoots: [resourcePath, "plugins/ZZZ-Plugin/resources"],
  raw: "https://raw.githubusercontent.com/ZZZure/ZZZ-Plugin/20575991eb9cd51461d6a10b186c66b2fc8e2309/resources/",
  assets: [
    ["common/fonts/inpinhongmengti.ttf", 1925852, "d2ac904501673027d6ca891abdcd346d2ae6527a713fcb477a151b47162185b2"],
    ["common/images/bg.jpg", 223824, "25a877d12a5114a540e11438181732bf5a6717f7c31d2e36e9675c45f10db68c"],
    ["common/images/SuitBg.png", 13455, "1b189df00b58952f0d34c5fd2df1b012ef529bd5538242ead0eaa8dd31500596"],
    ["common/images/UIDBg.png", 15431, "a14c959b46377b907dfef6b96ccc438863d16aa901c65f15a48d939681c7924b"],
    ["common/images/RANK_S.png", 13482, "231e3705b86c8c6c7ec309141186199865bf341c22e3ee0cab24d2a1b950061d"],
    ["gachalog/images/IconTabUP.png", 1833, "fdd5b63e4569de490c677c49f28194f9d33a53faa3966e9b45894aad65adb965"],
    ["gachalog/images/bg1.png", 272905, "64d8c429705491f6415d0025e6cf45593446bc5054e6765ba0a0c97bc4188e07"],
    ["gachalog/images/bg2.png", 226462, "3101bdefd13a6956d34c7c1fd58dc1dbf7b4aee35ffb3a73f6954889144cac98"],
    ["gachalog/images/bg3.png", 192759, "e60ef8e4e23c516fecf3a201657e2d6046a0eb783c96c6396bbc0ebb9948c839"],
    ["gachalog/images/emoji/4.png", 320103, "292c5eb59eaa7ddab0e68a9775b4f3ea24294857820cff0859256a3d25e83847"],
    ["gachalog/images/emoji/1.png", 410085, "2c715316b3832d26444e1c307ad4e861ec65db3a47f48c73a69982fad9da593b"],
    ["gachalog/images/emoji/16.png", 235140, "bb1720cbb6d70d8926d00ab07d9b7c268437d5257af44ed7461c605ce9ab2fad"],
    ["gachalog/images/emoji/12.png", 353288, "2ae282c3c1e72f824a33be59c93aa3466d5259ee1051761352244ff83a21f50b"],
    ["gachalog/images/emoji/6.png", 275359, "46a443ce5f532439b9c9f72d38b2d715dc26a0718a2dc578c0b827669d6a432e"],
  ],
} as const;

export function prepareZzzTuningTheme(checkout: URL, options?: FixedThemeOptions) {
  return prepareFixedTheme(checkout, theme, options);
}
