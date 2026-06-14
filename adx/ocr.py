import sys, ddddocr
o = ddddocr.DdddOcr(show_ad=False)
with open(sys.argv[1], 'rb') as f:
    print(o.classification(f.read()).strip())
