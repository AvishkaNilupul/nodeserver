import Foundation
import CoreML
import ImageIO
import CoreVideo
import Vision

func reply(_ value:[String:Any]) { let d=try! JSONSerialization.data(withJSONObject:value);print(String(data:d,encoding:.utf8)!);fflush(stdout) }
do {
    guard CommandLine.arguments.count==2 else {throw NSError(domain:"depth",code:1,userInfo:[NSLocalizedDescriptionKey:"Compiled model path required"])}
    let url=URL(fileURLWithPath:CommandLine.arguments[1]),config=MLModelConfiguration()
    config.computeUnits = .cpuAndNeuralEngine
    let compiled:URL
    if url.pathExtension=="mlmodelc" {compiled=url} else {
        let cached=url.deletingPathExtension().appendingPathExtension("mlmodelc")
        if !FileManager.default.fileExists(atPath:cached.path){
            let temporary=try MLModel.compileModel(at:url)
            try FileManager.default.copyItem(at:temporary,to:cached)
        }
        compiled=cached
    }
    let model=try MLModel(contentsOf:compiled,configuration:config)
    guard let input=model.modelDescription.inputDescriptionsByName.first(where:{$0.value.type == .image}),let constraint=input.value.imageConstraint else {throw NSError(domain:"depth",code:2)}
    reply(["ready":true,"input":input.key,"width":constraint.pixelsWide,"height":constraint.pixelsHigh])
    while let line=readLine() {
        do {
            let begin=Date()
            guard let data=line.data(using:.utf8),let request=try JSONSerialization.jsonObject(with:data) as? [String:Any],let file=request["file"] as? String,
                  let source=CGImageSourceCreateWithURL(URL(fileURLWithPath:file) as CFURL,nil),let image=CGImageSourceCreateImageAtIndex(source,0,nil) else {throw NSError(domain:"depth",code:3)}
            let value=try MLFeatureValue(cgImage:image,pixelsWide:constraint.pixelsWide,pixelsHigh:constraint.pixelsHigh,pixelFormatType:constraint.pixelFormatType,options:[.cropAndScale:VNImageCropAndScaleOption.scaleFill.rawValue])
            let prediction=try model.prediction(from:MLDictionaryFeatureProvider(dictionary:[input.key:value]))
            let gw=72,gh=48
            var grid=[Double]();grid.reserveCapacity(gw*gh)
            if let output=prediction.featureNames.compactMap({prediction.featureValue(for:$0)?.multiArrayValue}).first {
                let shape=output.shape.map{$0.intValue},strides=output.strides.map{$0.intValue}
                let h=shape[shape.count-2],w=shape[shape.count-1],sy=strides[strides.count-2],sx=strides[strides.count-1]
                for y in 0..<gh {for x in 0..<gw {grid.append(output[min(h-1,y*h/gh)*sy+min(w-1,x*w/gw)*sx].doubleValue)}}
            }else if let buffer=prediction.featureNames.compactMap({prediction.featureValue(for:$0)?.imageBufferValue}).first {
                CVPixelBufferLockBaseAddress(buffer,.readOnly);defer{CVPixelBufferUnlockBaseAddress(buffer,.readOnly)}
                let w=CVPixelBufferGetWidth(buffer),h=CVPixelBufferGetHeight(buffer),bytes=CVPixelBufferGetBytesPerRow(buffer),format=CVPixelBufferGetPixelFormatType(buffer)
                guard let base=CVPixelBufferGetBaseAddress(buffer),format==kCVPixelFormatType_OneComponent32Float||format==kCVPixelFormatType_OneComponent16Half else {throw NSError(domain:"depth",code:5,userInfo:[NSLocalizedDescriptionKey:"Unsupported depth format \(format)"])}
                for y in 0..<gh {for x in 0..<gw {
                    let row=base.advanced(by:min(h-1,y*h/gh)*bytes),ix=min(w-1,x*w/gw)
                    grid.append(format==kCVPixelFormatType_OneComponent32Float ? Double(row.assumingMemoryBound(to:Float.self)[ix]) : Double(row.assumingMemoryBound(to:Float16.self)[ix]))
                }}
            }else {throw NSError(domain:"depth",code:4,userInfo:[NSLocalizedDescriptionKey:"Depth output missing"])}
            reply(["ok":true,"width":gw,"height":gh,"inverseDepth":grid,"milliseconds":Int(Date().timeIntervalSince(begin)*1000)])
        }catch {reply(["ok":false,"error":error.localizedDescription])}
    }
}catch {reply(["ok":false,"error":error.localizedDescription]);exit(1)}
