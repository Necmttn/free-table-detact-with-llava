import { $ } from "bun";
import fs from "node:fs/promises";
import bunFs from "fs";
import { from, map, mergeMap, reduce, tap } from "rxjs";

const videoPath = "./video.mp4";
const outputDir = "./output";
const seatsDir = "./seats";

const convertVideoToImages = async (everyXSeconds: number) => {
  if (bunFs.existsSync(outputDir)) {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
  await fs.mkdir(outputDir);

  const { stdout } =
    await $`ffprobe -i ${videoPath} -show_entries format=duration -v quiet -of csv="p=0"`;
  const duration = parseFloat(stdout);

  console.log(`Video duration: ${duration} seconds`);

  const { stdout: frameCountOutput } =
    await $`ffprobe -i ${videoPath} -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -v quiet -of csv="p=0"`;
  const frameCount = parseInt(frameCountOutput);
  console.log(`Frame count: ${frameCount}`);

  const frameRate = frameCount / duration;
  console.log(`Frame rate: ${frameRate} frames per second`);

  const framesToTake = Math.floor(duration / everyXSeconds);
  const seatImages = (await fs.readdir(seatsDir)).filter((file) =>
    file.endsWith(".png")
  );

  from(Array.from({ length: framesToTake }, (_, i) => i))
    .pipe(
      mergeMap(async (frameIndex) => {
        const time = (frameIndex * everyXSeconds).toFixed(2);
        const outputImagePath = `${outputDir}/frame_${frameIndex}.jpg`;
        await $`ffmpeg -ss ${time} -i ${videoPath} -vframes 1 ${outputImagePath}`.quiet();
        console.log(`Saved frame ${frameIndex} as ${outputImagePath}`);

        return { frameIndex, outputImagePath };
      }, 1),
      mergeMap(
        ({ frameIndex, outputImagePath }) =>
          from(seatImages).pipe(
            mergeMap(async (seatImage) => {
              const timestamp = frameIndex * everyXSeconds;
              const overlayImagePath = `${outputImagePath}_overlay_${seatImage}`;
              const seatImagePath = `${seatsDir}/${seatImage}`;
              await $`ffmpeg -i ${outputImagePath} -i ${seatImagePath} -filter_complex "overlay" ${overlayImagePath}`.quiet();
              await $`ffmpeg -i ${overlayImagePath} -vf scale=320:-1 ${overlayImagePath}_small.png`.quiet();
              bunFs.unlinkSync(overlayImagePath);

              const imageBuffer = await fs.readFile(
                `${overlayImagePath}_small.png`
              );
              const imageBase64 = imageBuffer.toString("base64");
              const response = await fetch(
                "http://127.0.0.1:11434/api/generate",
                {
                  method: "POST",
                  body: JSON.stringify({
                    model: "llava",
                    prompt: `
                      You're trained to detect if a seat is occupied or not. 
                      Is there anyone sitting in red boxed seat? Respond using JSON
                      {
                        "frameIndex": ${frameIndex},
                        "seat": "${seatImage}"
                        "isOccupied": boolean 
                      }
                      `,
                    images: [imageBase64],
                    format: "json",
                    stream: false,
                  }),
                }
              );
              const responseData = await response.json();
              // console.log("RESPONSE", responseData);
              const seatNumber = `seat_${seatImage.match(/\d+/)![0]}`;

              const res = JSON.parse(responseData.response);

              bunFs.unlinkSync(`${overlayImagePath}_small.png`);
              return {
                [seatNumber]: res.isOccupied,
              };
            }, 3), // Limit concurrency to 1 for sequential processing
            reduce((acc, value) => ({ ...acc, ...value }), {}),
            map((result) => {
              return { [frameIndex * everyXSeconds]: result };
            })
          ),
        3
      ),
      reduce((acc, value) => ({ ...acc, ...value }), {}),
      tap((results) => {
        const outputFilePath = `${outputDir}/results.json`;
        fs.writeFile(outputFilePath, JSON.stringify(results, null, 2));
        console.log(`Saved results to ${outputFilePath}`);
      })
    )
    .subscribe({
      next: (overlayImagePath) =>
        console.log(`Processed and saved: ${JSON.stringify(overlayImagePath)}`),
      error: (err) => console.error(`Error: ${err}`),
      complete: () => console.log("Completed processing all frames."),
    });
};

convertVideoToImages(3);
